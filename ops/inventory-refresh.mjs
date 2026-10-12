// A7 基线刷新工具。默认 dry-run(只读);--apply 才写 inventory/**。
// 用法:node ops/inventory-refresh.mjs [--apply] [--root <仓库根>] [--home <HOME>] [--now <ISO,测试用>] [--backup-dir <目录>]
// 退出码(与 ops/accept 同表):
//   0 无需刷新(dry-run)/ 已刷新且 A7 重跑通过(apply)
//   1 dry-run 发现差异(列出,未写)/ apply 后 A7 仍不通过 / 改写后复验不一致(未写)
//   2 用法错  3 commands.sh 被拒(格式/只读检查)  4 有命令未执行(未写任何文件)
//   5 apply 已写入安全部分,但有「需人工核对」的位置(见输出)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, parseFlags, run, main, mergeExit } from './accept/lib/common.mjs';
import {
  applyWrites,
  buildPlan,
  defaultBackupDir,
  fileStats,
  planWrites,
} from './lib/inventory-refresh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const out = (s) => process.stdout.write(s + '\n');

const HELP = `inventory-refresh:重跑 inventory/commands.sh,刷新其期望值/时点,并同步 inventory/*.md 里 [#编号] 紧邻的数值。
  (默认)        dry-run:只读,列出变了的编号(旧 -> 新)、引用它们的 md 行、将要做的 md 修改与需人工核对的位置
  --apply       写入 inventory/**(先备份到仓库外临时目录,临时文件 + rename,失败回滚),再重跑 A7 自检
  --root DIR    仓库根(默认本脚本所在仓库)
  --home DIR    命令里 ~ 所指的 HOME(默认环境 HOME;设了 KIT_OPS_NO_REAL_HOME=1 时必须显式给)
  --now ISO     指定「本次时点」(默认当前 UTC;测试用)
  --backup-dir  备份目录(默认 $TMPDIR/inventory-refresh-XXXX)
退出码:0 无需刷新/已刷新且 A7 通过 | 1 有差异(dry-run)或 A7 仍红 | 2 用法 | 3 清单被拒 | 4 有命令未执行 | 5 已写入但有需人工核对项`;

function listValue(v) {
  return v.length > 200 ? `${v.slice(0, 200)}…(${v.length} 字符)` : v;
}

async function cli(argv) {
  const { flags } = parseFlags(argv, {
    bool: ['apply', 'help'],
    value: ['root', 'home', 'now', 'backup-dir'],
  });
  if (flags.help) {
    out(HELP);
    return EXIT.OK;
  }
  const root = fs.realpathSync(path.resolve(flags.root ?? REPO));
  let home = flags.home;
  if (home === undefined) {
    if (process.env.KIT_OPS_NO_REAL_HOME === '1')
      throw new UsageError('KIT_OPS_NO_REAL_HOME=1:必须显式 --home,拒绝使用真实 HOME');
    home = process.env.HOME;
    if (!home) throw new UsageError('没有 HOME,请显式 --home');
  }
  let now = new Date();
  if (flags.now !== undefined) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(flags.now))
      throw new UsageError('--now 需要 UTC ISO(秒级,Z 结尾)');
    now = new Date(flags.now);
  }

  const built = buildPlan({ root, home, now });
  if (built.code !== EXIT.OK) {
    for (const r of built.rejected) out(`[REFRESH] REJECTED ${r}`);
    return built.code;
  }
  const plan = built.plan;
  const n = plan.rows.length;
  const same = plan.results.filter((r) => r.status === 'same').length;
  out(
    `[REFRESH] 命令 ${n} 条:一致 ${same},变化 ${plan.changedRes.length},需人工(无法写入)${plan.manualRows.length},未执行 ${plan.notrun.length}`,
  );
  for (const r of plan.notrun) out(`[REFRESH] NOT-RUN ${r.row.id}: ${r.note}`);
  if (plan.notrun.length) {
    out('[REFRESH] 有命令未能执行,不写任何文件(未执行不能当作「一致」或「已刷新」)。');
    return EXIT.NOT_RUN;
  }
  for (const r of plan.changedRes)
    out(
      `[REFRESH] CHANGED ${r.row.id}: ${listValue(r.row.expected)} -> ${listValue(r.newExpected)}`,
    );
  for (const r of plan.manualRows) out(`[REFRESH] MANUAL ${r.row.id}: ${r.note}`);
  if (plan.refs.length) {
    out('[REFRESH] 引用了这些编号的 md 行:');
    for (const x of plan.refs)
      out(`  inventory/${x.file}:${x.line}  ${x.ids.map((i) => `[#${i}]`).join(' ')}`);
  }
  if (plan.inconsistent.length) {
    for (const m of plan.inconsistent)
      out(`[REFRESH] FAIL 改写后复验不一致 inventory/${m.file}:${m.line} [#${m.id}] ${m.reason}`);
    out('[REFRESH] 内部复验失败,不写任何文件。');
    return EXIT.FAIL;
  }
  if (plan.sync.edits.length) {
    out(`[REFRESH] md 将自动同步 ${plan.sync.edits.length} 处:`);
    const byPos = [...plan.sync.edits].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
    );
    for (const e of byPos)
      out(
        `  inventory/${e.file}:${e.line}  [#${e.id}]  ${listValue(e.old)} -> ${listValue(e.new)}`,
      );
  }
  for (const m of plan.manual)
    out(
      `[REFRESH] 需人工核对 ${m.file === 'commands.sh' ? '' : 'inventory/'}${m.file}:${m.line} [#${m.id}] ${m.reason}`,
    );
  for (const a of plan.advisories)
    out(`[REFRESH] 提示 ${a.file}${a.line ? `:${a.line}` : ''} ${a.reason}`);

  if (!plan.hasChanges) {
    if (plan.manual.length) {
      out('[REFRESH] 没有需要刷新的编号,但文档与期望值有不一致(见上「需人工核对」)。');
      return EXIT.ATTRIBUTE;
    }
    out('[REFRESH] 没有需要刷新的编号。');
    return EXIT.OK;
  }
  if (!flags.apply) {
    out('[REFRESH] dry-run:未写任何文件。确认后加 --apply。');
    return EXIT.FAIL;
  }

  const writes = planWrites(plan);
  if (writes.length === 0) {
    out('[REFRESH] 没有可安全写入的内容(只有需人工核对项),未写任何文件。');
    return plan.manual.length ? EXIT.ATTRIBUTE : EXIT.OK;
  }
  const backupDir = flags['backup-dir'] ?? defaultBackupDir();
  out(`[REFRESH] 备份目录(写入前原文件副本):${backupDir}`);
  // 仅测试用:KIT_REFRESH_TEST_FAIL_RENAME_AT=<n> 让第 n 次 rename 失败,演练回滚。默认不设置,无影响。
  const failAt = Number(process.env.KIT_REFRESH_TEST_FAIL_RENAME_AT ?? 0);
  let renames = 0;
  const rename =
    failAt > 0
      ? (a, b) => {
          if (++renames === failAt) throw new Error('测试注入的 rename 失败');
          fs.renameSync(a, b);
        }
      : fs.renameSync;
  applyWrites(root, writes, { backupDir, rename });
  out('[REFRESH] 已写入:');
  for (const s of fileStats(plan)) out(`  inventory/${s.file}  变更 ${s.lines} 行`);

  // 再跑一遍 A7(同一 root / home),确认回绿
  const a7 = run(
    process.execPath,
    [path.join(HERE, 'accept', 'lib', 'a7.mjs'), '--root', root, '--home', home],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 20 * 60_000,
    },
  );
  // A7 的 FAIL 行会带出期望值/实得值片段(文本型条目可能含文件内容),这里只留编号
  for (const l of a7.stdout.split('\n').filter(Boolean))
    out(l.replace(/^(\[A7\] FAIL [^:]+:).*$/, '$1 (不一致,值已省略;请单独运行 A7 查看)'));
  const a7code = a7.status ?? EXIT.NOT_RUN;
  out(`[REFRESH] A7 重跑 exit=${a7code}`);
  const manualCode = plan.manual.length ? EXIT.ATTRIBUTE : EXIT.OK;
  if (plan.manual.length) out(`[REFRESH] 有 ${plan.manual.length} 处需人工核对(见上),退出 5。`);
  return mergeExit([a7code, manualCode]);
}

await main('REFRESH', () => cli(process.argv.slice(2)));

// 总入口:A1–A15 验收汇总。`--list` 列 15 项(A13 为人工完成项并显示状态);`--only A1,A4`;任何 4 视为失败。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXIT,
  DEFAULT_ROOT,
  UsageError,
  cleanEnv,
  mergeExit,
  parseFlags,
  runMain,
} from './common.mjs';
import { spawnSync } from 'node:child_process';

export const ITEMS = [
  {
    id: 'A1',
    title: '确定性:四种环境 out/ 树哈希全等,无时间戳/绝对路径/用户名',
    script: 'a1-determinism.sh',
  },
  {
    id: 'A2',
    title: '预算:12 格矩阵逐格、kit.toml 为 warn、真实仓库 check 退出 0',
    script: 'a2-budget.sh',
  },
  { id: 'A3', title: '脱敏:种子全形态 + 变异自检', script: 'a3-redaction.sh' },
  { id: 'A4', title: '冲突/守卫 fixture + 正向控制', script: 'a4-merge-guards.sh' },
  { id: 'A5', title: '零写入(假 HOME + 受管路径快照,硬门槛)', script: 'a5-zero-write.sh' },
  {
    id: 'A6',
    title: 'reader 对照 oracle(硬门槛;需 .state/reader-samples.local.txt)',
    script: 'a6-readers.sh',
  },
  { id: 'A7', title: '盘点复算(inventory/commands.sh)', script: 'a7-inventory-recount.sh' },
  { id: 'A8', title: '运行期无网络(no-net 垫片 + 正向对照)', script: 'a8-no-net.sh' },
  { id: 'A9', title: '写入只经唯一出口(静态扫描 + eslint + test/io)', script: 'a9-write-gate.sh' },
  {
    id: 'A10',
    title: '隐私卫生(.state 权限、会话原文不入库、全量脱敏扫描)',
    script: 'a10-privacy.sh',
  },
  {
    id: 'A11',
    title: '供应链(精确版本、lockfile、audit、许可证清单)',
    script: 'a11-supply-chain.sh',
  },
  {
    id: 'A12',
    title: '全量绿灯(干净克隆里 typecheck/build/test/lint/format:check)',
    script: 'a12-green.sh',
  },
  { id: 'A13', title: '变异抽检(5 处关键逻辑变异必须变红)', manual: true, doc: 'a13-mutation.md' },
  { id: 'A14', title: '交付物齐全(命令面、桩退出 64、文件清单)', script: 'a14-deliverables.sh' },
  {
    id: 'A15',
    title: 'personal 层不入 core 输出(manifest 逐文件核对)',
    script: 'a15-no-personal-in-out.sh',
  },
];

export const A13_MARKER = path.join('.state', 'accept', 'a13.done');

/**
 * A13 的状态。标记文件格式(见 a13-mutation.md):
 *   head: <40 位提交 SHA>      必须等于当前 HEAD(换了提交就作废)
 *   result: 5/5 red             恰好这一行
 *   M1: red … M5: red           恰好五行
 * 返回 { state: 'done'|'todo'|'stale'|'invalid', detail }。
 */
export function a13Status(root) {
  const file = path.join(root, A13_MARKER);
  if (!fs.existsSync(file)) return { state: 'todo', detail: `缺 ${A13_MARKER}` };
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const head = lines.find((l) => l.startsWith('head: '))?.slice(6);
  if (!head || !/^[0-9a-f]{40}$/.test(head))
    return { state: 'invalid', detail: '标记无效(缺 head: <40 位 SHA>)' };
  if (lines.filter((l) => l === 'result: 5/5 red').length !== 1)
    return { state: 'invalid', detail: '标记无效(缺恰好一行 "result: 5/5 red")' };
  for (let i = 1; i <= 5; i++) {
    if (lines.filter((l) => l === `M${i}: red`).length !== 1)
      return { state: 'invalid', detail: `标记无效(缺 "M${i}: red")` };
  }
  const extra = lines.filter((l) => !/^(head: |result: |M[1-5]: red$)/.test(l));
  if (extra.length) return { state: 'invalid', detail: `标记含多余内容:${extra[0].slice(0, 40)}` };
  const cur = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
  });
  if (cur.status !== 0)
    return { state: 'invalid', detail: '无法读取当前 HEAD,不能确认标记仍然有效' };
  if (cur.stdout.trim() !== head)
    return {
      state: 'stale',
      detail: `标记已过期(记录于 ${head.slice(0, 12)},当前 HEAD ${cur.stdout.trim().slice(0, 12)})`,
    };
  return { state: 'done', detail: `5/5 red,HEAD ${head.slice(0, 12)}` };
}

export function parseOnly(value) {
  const ids = value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (ids.length === 0) throw new UsageError('--only 需要至少一个编号');
  for (const id of ids)
    if (!ITEMS.some((i) => i.id === id))
      throw new UsageError(`未知编号 ${id}(有效:${ITEMS.map((i) => i.id).join(',')})`);
  return [...new Set(ids)];
}

export function listLines(root) {
  const out = [];
  for (const it of ITEMS) {
    if (it.manual) {
      const s = a13Status(root);
      out.push(
        `${it.id.padEnd(4)} 【人工完成项】${it.title}  状态:${s.state === 'done' ? '已做' : '未做'}(${s.detail})  清单:ops/accept/${it.doc}`,
      );
    } else out.push(`${it.id.padEnd(4)} ${it.title}  ops/accept/${it.script}`);
  }
  return out;
}

const STATUS_NAME = {
  0: 'PASS',
  1: 'FAIL',
  2: 'USAGE',
  3: 'REJECTED',
  4: 'NOT-RUN',
  5: 'ATTRIBUTE',
};

async function acceptMain(argv) {
  const { flags } = parseFlags(argv, { bool: ['list', 'help'], value: ['only', 'root', 'cli'] });
  if (flags.help) {
    process.stdout.write(
      '用法:ops/accept-p0.sh [--list] [--only A1,A4] [--root <仓库根>] [--cli <dist/cli.js>]\n' +
        '无参:依次运行 A1–A15 并汇总(A13 为人工完成项,按标记文件判定)。任何 4(未执行)都按失败汇总。\n' +
        '退出码:0 全部通过 | 1 有违规 | 2 用法错 | 3 清单被拒 | 4 有未执行/人工项未完成 | 5 待人工归因\n',
    );
    return EXIT.OK;
  }
  const root = path.resolve(flags.root ?? DEFAULT_ROOT);
  if (flags.list) {
    process.stdout.write(listLines(root).join('\n') + '\n');
    return EXIT.OK;
  }
  const only = flags.only ? parseOnly(flags.only) : ITEMS.map((i) => i.id);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const results = [];
  for (const it of ITEMS.filter((i) => only.includes(i.id))) {
    if (it.manual) {
      const s = a13Status(root);
      results.push({ id: it.id, code: s.state === 'done' ? 0 : 4, note: `人工完成项:${s.detail}` });
      process.stdout.write(
        `\n=== ${it.id} ${it.title}\n[${it.id}] ${s.state === 'done' ? 'PASS' : 'NOT-RUN'} 人工完成项:${s.detail}\n`,
      );
      continue;
    }
    process.stdout.write(`\n=== ${it.id} ${it.title}\n`);
    const args = [
      path.join(here, '..', it.script),
      '--root',
      root,
      ...(flags.cli ? ['--cli', flags.cli] : []),
    ];
    const r = spawnSync('bash', args, { stdio: 'inherit', env: process.env });
    const code = r.status === null ? 4 : r.status;
    results.push({
      id: it.id,
      code: [0, 1, 2, 3, 4, 5].includes(code) ? code : 1,
      note: r.status === null ? '异常终止' : '',
    });
  }
  process.stdout.write('\n=== 汇总\n');
  for (const r of results)
    process.stdout.write(
      `${r.id.padEnd(4)} ${STATUS_NAME[r.code].padEnd(9)} exit=${r.code}${r.note ? `  ${r.note}` : ''}\n`,
    );
  const passed = results.filter((r) => r.code === 0).length;
  const failing = results.filter((r) => r.code !== 0);
  process.stdout.write(
    `通过 ${passed}/${results.length};未通过 ${failing.map((r) => r.id).join(',') || '无'}\n`,
  );
  if (failing.some((r) => r.code === 4))
    process.stdout.write('注意:4=未执行,按失败汇总,不是通过。\n');
  return mergeExit(results.map((r) => r.code));
}

await runMain(import.meta.url, 'accept-p0', () => acceptMain(process.argv.slice(2)));

// A28 sync / update 变异抽检(与 A13 / A20 / A24 同构的人工完成项)。
//   默认:只报告标记文件状态(.state/accept/a28.done,绑定 HEAD;换了提交就作废)。
//   --run [--ids S1,S4] [--write-marker]:真的做变异——每处先 cp 备份、断言替换匹配数恰好 1、跑对应 vitest 必须变红
//     (redTitles 里至少一条用例须以**完整标题精确**变红,见 common.mjs judgeMutationRed)、cp 还原并恢复原 mtime;全部做完再跑一次基线必须为绿。
//     vitest 在**假 HOME**(tmp/sbx-home;KIT_TMP 与 TMPDIR 在同级 tmp/sbx-kit)下运行,开始与结束各取一次真实 HOME 快照(受管路径 +
//     套件 share/state/config 目录),有差异按"待人工归因"(5)报,不写标记。
//     还原只用 cp(不用 git checkout:会丢掉未提交的改动)。SIGINT/SIGTERM 会先还原再退出;SIGKILL 会留下 .mut-bak,
//     下一次运行与 freshDist 都会拒绝继续。--write-marker 要求工作树干净(标记只绑 HEAD)。
//   变异表见 MUTATIONS;清单与做法见 ops/accept/a28-mutation.md。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT,
  Reporter,
  cleanEnv,
  judgeMutationRed,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  runMain,
  runVitest,
  sandbox,
} from './common.mjs';
import { applyEdit } from './a20.mjs';
import { realHomeGuard } from './real-home-guard.mjs';

export const A28_MARKER = path.join('.state', 'accept', 'a28.done');
export const A28_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

const T_SYNC_CMD = 'test/sync/command.test.ts';
const T_SYNC_REC = 'test/sync/recovery.test.ts';
const T_SYNC_LOCK = 'test/sync/lock-lost.test.ts';
const T_SYNC_BACKUP = 'test/sync/rollback-backup-sha.test.ts';
const T_UPD_REG = 'test/update/registry.test.ts';
const T_UPD_FLOW = 'test/update/install-flow.test.ts';
const T_UPD_ROLL = 'test/update/install-rollback.test.ts';

/** edits 的 find 必须在文件里恰好出现 1 次;redTitles:预期变红用例的完整标题(vitest fullName,精确相等;判据见 common.mjs judgeMutationRed)。 */
export const MUTATIONS = [
  {
    id: 'S1',
    what: '卸载不删块(block_remove 不再从文件里移除托管块)',
    edits: [
      {
        file: 'src/sync/txn.ts',
        find: '        const rest = removeBlockText(beforeText, op.blockId as string);',
        replace: '        const rest = beforeText;',
      },
    ],
    tests: [T_SYNC_CMD, T_SYNC_REC],
    redTitles: [
      'sync:往返与幂等 装 → 卸载:受管路径树逐字节一致(忽略状态目录与 sync 自己建的空目录)',
      'sync:卸载 只卸一个 agent:共用路径仍被其它 agent 请求就保留,登记条目只去掉该 agent',
    ],
  },
  {
    id: 'S2',
    what: '回滚时备份内容不校验 sha(被改过的备份也会被当作写前全文还原)',
    edits: [
      {
        file: 'src/sync/apply.ts',
        find: "      if (t === undefined || sha256Of(t) !== r.before) throw mismatch('backup_missing');",
        replace: "      if (t === undefined) throw mismatch('backup_missing');",
      },
    ],
    tests: [T_SYNC_BACKUP],
    redTitles: [
      'sync --rollback:备份内容必须核对 sha 备份内容被改(sha 对不上)=> SYNC_ROLLBACK_MISMATCH,整次不写',
    ],
  },
  {
    id: 'S3',
    what: '回滚不检前提(文件当前 sha 不等于该事务写入后的 sha 也照样还原)',
    edits: [
      {
        file: 'src/sync/apply.ts',
        find: '    if (cur === lv.after) {\n      restores.push({ path: p, before: lv.before, after: lv.after });',
        replace:
          '    if (true) {\n      restores.push({ path: p, before: lv.before, after: lv.after });',
      },
    ],
    tests: [T_SYNC_REC],
    redTitles: [
      'sync:崩溃一致性 回滚前提不成立 → SYNC_ROLLBACK_MISMATCH,整次不写(文件被改 / 登记表被改 / 不是最新事务 / 未知事务)',
    ],
  },
  {
    id: 'S4',
    what: 'registry 夹具路径守卫放宽(KIT_TMP 之外的 file:// 目录也被接受)',
    edits: [
      {
        file: 'src/update/registry.ts',
        find: "    if (!within(tmpReal, dir)) return { ok: false, reason: 'registry_fixture_outside_tmp' };",
        replace: "    if (false) return { ok: false, reason: 'registry_fixture_outside_tmp' };",
      },
    ],
    tests: [T_UPD_REG],
    redTitles: [
      'fixture registry KIT_TMP 之外 / 没有 KIT_TMP / 非 file:// 写法 → registry_fixture_outside_tmp',
    ],
  },
  {
    id: 'S5',
    what: '锁不复核 assertHeld(锁被别人夺走后仍继续写)',
    edits: [
      {
        file: 'src/sync/apply.ts',
        find: "          if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) {\n            throw new ApplyError('SYNC_LOCKED', 'lost');",
        replace:
          "          if (false as boolean) {\n            throw new ApplyError('SYNC_LOCKED', 'lost');",
      },
    ],
    tests: [T_SYNC_LOCK],
    redTitles: [
      'sync:提交点前复核锁所有权 journal 写完后锁被夺走:不写任何受管文件,退出 4 SYNC_LOCKED,别人的锁不被删;对照:不夺锁则写完',
      'sync:提交点前复核锁所有权 写第一个文件之后锁被夺走:不继续写后面的文件与登记表',
      'sync:--rollback / --resume / 仅登记表写入同样在写出口前复核锁(K6) --rollback:回滚事务的 journal 写完后锁被夺走 → 退出 4,不还原任何文件',
      'sync:收尾阶段(journal 删除 / 备份修剪)同样复核锁(K6 评审补) journal 写完后锁被夺走:不建任何备份(备份目录不存在);对照:不夺锁则备份目录存在',
    ],
  },
  {
    id: 'S6',
    what: '完整性校验跳过(dist.integrity 与 tarball 不符也继续安装)',
    edits: [
      {
        file: 'src/update/install.ts',
        find: '    if (!input.mirror && !sriMatches(input.distIntegrity, tgz.sha512Hex)) {',
        replace: '    if (false as boolean) {',
      },
    ],
    tests: [T_UPD_FLOW],
    redTitles: [
      '校验失败(fail-closed) dist.integrity 与 tarball 不符(非镜像)→ integrity,拉黑,不再重试',
    ],
  },
  {
    id: 'S7',
    what: '回滚不验上一版本目录的完整树(被篡改的上一版本也被切回)',
    edits: [
      {
        file: 'src/update/install.ts',
        find: "  if (!check.ok) return { ok: false, reason: 'previous_invalid' };",
        replace: '  if (false as boolean) return { ok: false, reason: "previous_invalid" };',
      },
    ],
    tests: [T_UPD_ROLL],
    redTitles: [
      '回滚 上一版本目录被篡改 → 不切(完整树校验),退出 3,current 仍指向当前版本',
      '回滚 上一版本目录里多了文件 → 同样拒绝',
    ],
  },
  {
    id: 'S8',
    what: 'sync 写前不复核文件当前 sha(计划之后被用户改过的文件会被覆盖 / 删除)',
    edits: [
      {
        file: 'src/sync/apply.ts',
        find: '    if (cur !== e.beforeSha) {\n      throw resumed',
        replace: '    if (false as boolean) {\n      throw resumed',
      },
    ],
    tests: [T_SYNC_REC],
    redTitles: ['sync:卸载 计划之后、写盘之前文件被改(竞态):写前复核指纹,拒绝覆盖 / 删除用户版本'],
  },
];

/** 标记文件状态(同 A24):done / todo / stale / invalid。 */
export function a28Status(root) {
  const file = path.join(root, A28_MARKER);
  if (!fs.existsSync(file)) return { state: 'todo', detail: `缺 ${A28_MARKER}` };
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const heads = lines.filter((l) => l.startsWith('head: '));
  if (heads.length !== 1 || !/^head: [0-9a-f]{40}$/.test(heads[0]))
    return { state: 'invalid', detail: '标记无效(缺恰好一行 head: <40 位 SHA>)' };
  const head = heads[0].slice(6);
  const want = `result: ${A28_IDS.length}/${A28_IDS.length} red`;
  if (lines.filter((l) => l === want).length !== 1)
    return { state: 'invalid', detail: `标记无效(缺恰好一行 "${want}")` };
  for (const id of A28_IDS) {
    if (lines.filter((l) => l === `${id}: red`).length !== 1)
      return { state: 'invalid', detail: `标记无效(缺 "${id}: red")` };
  }
  const extra = lines.filter(
    (l) => !(/^head: [0-9a-f]{40}$/.test(l) || l === want || /^S[1-8]: red$/.test(l)),
  );
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
  return {
    state: 'done',
    detail: `${A28_IDS.length}/${A28_IDS.length} red,HEAD ${head.slice(0, 12)}`,
  };
}

async function a28(argv) {
  const R_ = new Reporter('A28');
  const { flags } = parseCommon(argv, {
    bool: ['run', 'write-marker'],
    value: ['ids', 'home'],
  });
  const ctx = makeCtx(flags);
  if (!flags.run) {
    const s = a28Status(ctx.root);
    if (s.state === 'done') R_.pass(`人工完成项:${s.detail}`);
    else
      R_.notRun(
        `人工完成项未完成:${s.detail}(按 ops/accept/a28-mutation.md 做,或 --run --write-marker)`,
      );
    return R_.exit();
  }
  const only = flags.ids ? new Set(String(flags.ids).split(',')) : undefined;
  const list = MUTATIONS.filter((m) => only === undefined || only.has(m.id));
  if (list.length === 0) {
    R_.usage('没有选中任何变异');
    return R_.exit();
  }
  for (const f of [...new Set(MUTATIONS.flatMap((m) => m.edits.map((e) => e.file)))]) {
    if (fs.existsSync(path.join(ctx.root, `${f}.mut-bak`))) {
      R_.notRun(`${f}.mut-bak 已存在(上次变异没还原?先人工处理,不覆盖)`);
      return R_.exit();
    }
  }
  if (flags.writeMarker) {
    const dirty = spawnSync(
      'git',
      ['-C', ctx.root, 'status', '--porcelain', '--untracked-files=normal'],
      {
        encoding: 'utf8',
        env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
      },
    );
    if (dirty.status !== 0) {
      R_.notRun('无法读取 git 状态,不能确认工作树干净,拒绝写标记');
      return R_.exit();
    }
    if (dirty.stdout.trim() !== '') {
      R_.notRun(
        `工作树不干净(${dirty.stdout.trim().split('\n').length} 项):先提交,再在干净的 HEAD 上 --write-marker`,
      );
      return R_.exit();
    }
  }
  for (const t of [...new Set(list.flatMap((m) => m.tests))]) {
    if (!fs.existsSync(path.join(ctx.root, t))) {
      R_.notRun(`变异用的测试文件不存在:${t}`);
      return R_.exit();
    }
  }

  const gitOut = (args) =>
    spawnSync('git', ['-C', ctx.root, ...args], {
      encoding: 'utf8',
      env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
    });
  const startHead = gitOut(['rev-parse', 'HEAD']).stdout.trim(); // 标记绑定的是开跑时的 HEAD,结束时必须仍是它
  const tmp = mkTmp(ctx, 'a28');
  // 假 HOME:vitest 的 HOME 指向 tmp/sbx-home,KIT_TMP 与 TMPDIR 在同级的 tmp/sbx-kit(产品拒绝「KIT_TMP 是 HOME 的上级」),
  // 变异窗口里任何失控的写入都落不到真实 HOME
  const sb = sandbox(tmp);
  const fakeTmpdir = path.join(sb.kit, 'tmpdir');
  fs.mkdirSync(fakeTmpdir, { recursive: true });
  const guard = await realHomeGuard(ctx, flags.home);
  const homeBefore = guard.take();
  const vitest = (files) =>
    runVitest(ctx, sb.kit, files, [], { HOME: sb.home, TMPDIR: fakeTmpdir });

  const pending = [];
  const restoreOne = (s) => {
    fs.copyFileSync(`${s.abs}.mut-bak`, s.abs);
    fs.rmSync(`${s.abs}.mut-bak`);
    fs.utimesSync(s.abs, s.atime, s.mtime);
  };
  const restoreAll = () => {
    for (const s of pending.splice(0)) {
      try {
        restoreOne(s);
      } catch {
        /* 已还原 */
      }
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      restoreAll();
      process.exit(130);
    });
  }
  const union = [...new Set(list.flatMap((m) => m.tests))];
  const baseline = (label) => {
    const v = vitest(union);
    if (v.code === EXIT.OK) {
      R_.pass(`${label}基线为绿(${v.evaluation.passed}/${v.evaluation.total})`);
      return true;
    }
    R_.notRun(`${label}基线不是绿的,变异结果无意义:${v.why}`);
    return false;
  };
  const results = [];
  let aborted = false;
  try {
    aborted = !baseline('变异前');
    for (const m of aborted ? [] : list) {
      const saved = [];
      let outcome;
      try {
        for (const e of m.edits) {
          const abs = path.join(ctx.root, e.file);
          if (!saved.some((s) => s.abs === abs)) {
            const st = fs.statSync(abs);
            fs.copyFileSync(abs, `${abs}.mut-bak`, fs.constants.COPYFILE_EXCL); // 已有备份就抛错,不覆盖(并发实例的保险)
            const rec = { abs, atime: st.atime, mtime: st.mtime };
            saved.push(rec);
            pending.push(rec);
          }
          fs.writeFileSync(abs, applyEdit(fs.readFileSync(abs, 'utf8'), e.find, e.replace));
        }
        const v = vitest(m.tests);
        outcome = judgeMutationRed(v, m.redTitles);
      } catch (e) {
        outcome = { red: false, note: String(e?.message ?? e) };
      } finally {
        for (const s of saved) {
          restoreOne(s);
          pending.splice(pending.indexOf(s), 1);
        }
      }
      results.push({ id: m.id, what: m.what, ...outcome });
      if (outcome.red) R_.pass(`${m.id} ${m.what}:变红(${outcome.note})`);
      else R_.fail(`${m.id} ${m.what}:${outcome.note}`);
    }
    if (!aborted) baseline('还原后');
  } finally {
    restoreAll();
  }
  const n = guard.diff(homeBefore, guard.take());
  if (n === 0)
    R_.pass(
      '真实 HOME 的受管路径与套件 share/state/config 目录前后无差异(变异期间 vitest 用假 HOME)',
    );
  else
    R_.attribute(
      `真实 HOME 出现 ${n} 处差异;请用 ops/zero-write-check.sh 归因(多半是其它进程的写入)`,
    );
  rmTmp(tmp);
  if (aborted) return R_.exit();

  const allRed = results.every((r) => r.red);
  if (flags.writeMarker) {
    if (only !== undefined) R_.usage('--write-marker 不能与 --ids 一起用(必须做全部变异)');
    else if (!allRed || results.length !== A28_IDS.length || R_.codes.length > 0)
      R_.fail(`不是 ${A28_IDS.length}/${A28_IDS.length} 变红、基线为绿且真实 HOME 无差异,不写标记`);
    else if (
      gitOut(['rev-parse', 'HEAD']).stdout.trim() !== startHead ||
      gitOut(['status', '--porcelain', '--untracked-files=normal']).stdout.trim() !== ''
    )
      R_.fail('运行期间 HEAD 变了或工作树被改动:不写标记(标记只绑开跑时的干净 HEAD)');
    else {
      const head = startHead;
      const file = path.join(ctx.root, A28_MARKER);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          `head: ${head}`,
          `result: ${A28_IDS.length}/${A28_IDS.length} red`,
          ...A28_IDS.map((i) => `${i}: red`),
          '',
        ].join('\n'),
      );
      R_.info(`已写标记 ${A28_MARKER}(绑定 HEAD ${head.slice(0, 12)})`);
    }
  }
  return R_.exit();
}

await runMain(import.meta.url, 'A28', () => a28(process.argv.slice(2)));

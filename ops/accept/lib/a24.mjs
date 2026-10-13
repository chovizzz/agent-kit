// A24 生命周期功能变异抽检(与 A20 同构的人工完成项)。
//   默认:只报告标记文件状态(.state/accept/a24.done,绑定 HEAD;换了提交就作废)。
//   --run [--set a24|all] [--ids L1,L4] [--write-marker]:真的做变异——每处先 cp 备份、断言替换匹配数恰好 1、
//     跑对应 vitest 必须变红(失败用例标题须命中该变异的 redTitles)、cp 还原并**恢复原 mtime**;全部做完再跑一次基线必须为绿。
//     与 A20 的区别:A20 变异期间不碰 dist,但还原后重新 build;A24 的变异窗口里同样**不构建 dist**(vitest 直接跑 src 的 .ts),
//     所以还原 mtime 之后 dist 与 src 仍然一致,A16–A19 不会因此变成"未执行"。
//     进程收到 SIGINT/SIGTERM 会先还原再退出;SIGKILL 会留下 .mut-bak,下一次运行与 freshDist 都会拒绝继续。
//     --write-marker 要求工作树干净(标记只绑 HEAD,脏树上写的标记会在之后的任何改动下继续有效),且只对 --set a24 且全部变红时写。
//   变异表见 MUTATIONS(核心 9 处 L1–L9 + 验收脚本自检 X1–X2);清单与做法见 ops/accept/a24-mutation.md。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT,
  Reporter,
  cleanEnv,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  runMain,
  runVitest,
} from './common.mjs';
import { applyEdit } from './a20.mjs';

export const A24_MARKER = path.join('.state', 'accept', 'a24.done');
export const A24_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];

const T_CHECKS_TEXT = 'test/lifecycle/checks-text.test.ts';
const T_CHECKS_GOV = 'test/lifecycle/checks-gov.test.ts';
const T_ADOPT = 'test/commands/promote-adopt.test.ts';
const T_PROMOTE = 'test/commands/promote.test.ts';
const T_RETIRE = 'test/commands/retire.test.ts';
const T_CRITERIA = 'test/guards/criteria.test.ts';
const T_OPS = 'test/accept/p1-lifecycle-ops.test.ts';

/** edits 的 find 必须在文件里恰好出现 1 次;redTitles:失败用例标题须至少命中其中一个子串。 */
export const MUTATIONS = [
  {
    id: 'L1',
    core: true,
    what: 'C1 跳过 injection 复核(本地危险话术扫描的命中被忽略)',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        find: "    if (v.blocked.length > 0) {\n      hits.push({ reason: 'DANGEROUS_PHRASE', field: f.path });",
        replace:
          "    if (false) {\n      hits.push({ reason: 'DANGEROUS_PHRASE', field: f.path });",
      },
    ],
    tests: [T_CHECKS_TEXT],
    redTitles: ['C1 本地重扫注入'],
  },
  {
    id: 'L2',
    core: true,
    what: 'C6 不归一化(对原子全文直接取哈希,status / review_by 的改动会改哈希)',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        find: '    now = ruleSha256(input.atomText);',
        replace: "    now = createHash('sha256').update(input.atomText, 'utf8').digest('hex');",
      },
    ],
    tests: [T_CHECKS_GOV, T_ADOPT],
    redTitles: ['C6 规则文本与评审绑定', '端到端'],
  },
  {
    id: 'L3',
    core: true,
    what: 'judge 不写 rule_sha256(评审结论不再绑定规则文本)',
    edits: [
      {
        file: 'src/judge/run.ts',
        find: '        rule_sha256: ruleSha256(loaded.ruleText),\n',
        replace: '',
      },
    ],
    tests: [T_ADOPT, 'test/judge/rule-hash.test.ts'],
    redTitles: ['端到端', 'rule_sha256'],
  },
  {
    id: 'L4',
    core: true,
    what: 'promote --run 用评审前的旧补丁内容(补丁里的提案文件不含 judge 记录)',
    edits: [
      {
        file: 'src/lifecycle/adopt.ts',
        find: 'files.push({ path: proposalPath, content: l.text }, { path: atomPath, content: atomText });',
        replace:
          "files.push({ path: proposalPath, content: l.text.replace(/^judge:\\n(?:[ \\t]+.*\\n)+/m, '') }, { path: atomPath, content: atomText });",
      },
    ],
    tests: [T_ADOPT],
    redTitles: ['端到端'],
  },
  {
    id: 'L5',
    core: true,
    what: '晋升不查 attest 阈值(窗口 / 成员数 / 非 owner / 曝光 / 有害 全部放行)',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        find: '  const need = (cond: boolean, code: string, msg: string): void => {\n    if (!cond) out.push(e(code, a.path, msg));\n  };',
        replace:
          '  const need = (cond: boolean, code: string, msg: string): void => {\n    void cond;\n    void code;\n    void msg;\n  };',
      },
    ],
    tests: [T_CRITERIA, T_PROMOTE],
    redTitles: ['THRESHOLD_'],
  },
  {
    id: 'L6',
    core: true,
    what: 'retire 不写 lifecycle 记录(补丁只改 status,不新增审计记录 / 墓碑)',
    edits: [
      {
        file: 'src/lifecycle/retire.ts',
        find: '    patch = buildAddFilePatch(sim.recordPath, sim.recordText) + atomPatch;',
        replace: '    patch = atomPatch;',
      },
    ],
    tests: [T_RETIRE],
    redTitles: ['kit:retire 绿', '审计记录'],
  },
  {
    id: 'L7',
    core: true,
    what: '墓碑不参与 C7(退役记录目录里的 id 可被重新采纳)',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        find: "  if (input.tombstoneIds.has(id)) hits.push({ reason: 'ID_TOMBSTONED', field: 'id' });",
        replace: '',
      },
    ],
    tests: [T_CHECKS_GOV, T_PROMOTE],
    redTitles: ['墓碑', 'C7 id 与去重', 'ID_TOMBSTONED'],
  },
  {
    id: 'L8',
    core: true,
    what: 'CI 判据比本地 C5 宽(去掉 C5_EXTRA:provider / 最后一跳 ok / 厂商可复算 三条不再查)',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        find: '    if (C5_EXTRA_REASONS.has(reason)) {',
        replace: '    if (false) {',
      },
    ],
    tests: [T_CRITERIA],
    redTitles: ['C5 独有'],
  },
  {
    id: 'L9',
    core: true,
    what: '--write 缺省也写(promote --rule 干跑也落盘 .state/promote)',
    edits: [
      {
        file: 'src/commands/promote.ts',
        find: '    if (args.write) ({ wrote, existing } = await writeOut(io, plan));',
        replace: '    if (true) ({ wrote, existing } = await writeOut(io, plan));',
      },
    ],
    tests: [T_PROMOTE],
    redTitles: ['干跑:退出 0、只算不写'],
  },
  // ---- 验收脚本自检(不计入标记的核心九处) ----
  {
    id: 'X1',
    what: 'A21 矩阵不再逐条核对原因码',
    edits: [
      {
        file: 'ops/accept/lib/a21.mjs',
        find: '  if (!okReasons) out.push(',
        replace: '  if (false) out.push(',
      },
    ],
    tests: [T_OPS],
    redTitles: ['A21'],
  },
  {
    id: 'X2',
    what: 'A22 的 import 图检查不再拒绝 llm-exec',
    edits: [
      {
        file: 'ops/accept/lib/import-graph.mjs',
        find: '    if (opts.forbiddenFiles.includes(f)) problems.push(',
        replace: '    if (false) problems.push(',
      },
    ],
    tests: [T_OPS],
    redTitles: ['A22'],
  },
];

/** 标记文件状态(同 A20):done / todo / stale / invalid。 */
export function a24Status(root) {
  const file = path.join(root, A24_MARKER);
  if (!fs.existsSync(file)) return { state: 'todo', detail: `缺 ${A24_MARKER}` };
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const heads = lines.filter((l) => l.startsWith('head: '));
  if (heads.length !== 1 || !/^head: [0-9a-f]{40}$/.test(heads[0]))
    return { state: 'invalid', detail: '标记无效(缺恰好一行 head: <40 位 SHA>)' };
  const head = heads[0].slice(6);
  const want = `result: ${A24_IDS.length}/${A24_IDS.length} red`;
  if (lines.filter((l) => l === want).length !== 1)
    return { state: 'invalid', detail: `标记无效(缺恰好一行 "${want}")` };
  for (const id of A24_IDS) {
    if (lines.filter((l) => l === `${id}: red`).length !== 1)
      return { state: 'invalid', detail: `标记无效(缺 "${id}: red")` };
  }
  // 每一行都必须整行精确匹配(前缀匹配会放过 "result: 9/9 red 假的" 这类多余内容)
  const extra = lines.filter(
    (l) => !(/^head: [0-9a-f]{40}$/.test(l) || l === want || /^L[1-9]: red$/.test(l)),
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
    detail: `${A24_IDS.length}/${A24_IDS.length} red,HEAD ${head.slice(0, 12)}`,
  };
}

const failedTitles = (ev) => ev.titles.filter((t) => t.status === 'failed').map((t) => t.fullName);

async function a24(argv) {
  const R_ = new Reporter('A24');
  const { flags } = parseCommon(argv, { bool: ['run', 'write-marker'], value: ['set', 'ids'] });
  const ctx = makeCtx(flags);
  if (!flags.run) {
    const s = a24Status(ctx.root);
    if (s.state === 'done') R_.pass(`人工完成项:${s.detail}`);
    else
      R_.notRun(
        `人工完成项未完成:${s.detail}(按 ops/accept/a24-mutation.md 做,或 --run --set a24 --write-marker)`,
      );
    return R_.exit();
  }
  const set = flags.set ?? 'a24';
  if (!['a24', 'all'].includes(set)) {
    R_.usage('--set 只能是 a24 或 all');
    return R_.exit();
  }
  const only = flags.ids ? new Set(String(flags.ids).split(',')) : undefined;
  const list = MUTATIONS.filter(
    (m) => (set === 'all' || m.core) && (only === undefined || only.has(m.id)),
  );
  if (list.length === 0) {
    R_.usage('没有选中任何变异');
    return R_.exit();
  }
  // 遗留的 .mut-bak 检查覆盖全表(不只是本次选中的变异):上次 --set all 被 SIGKILL 时,X 类变异的文件也要被发现
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
  const tmp = mkTmp(ctx, 'a24');
  const pending = [];
  const restoreOne = (s) => {
    fs.copyFileSync(`${s.abs}.mut-bak`, s.abs);
    fs.rmSync(`${s.abs}.mut-bak`);
    fs.utimesSync(s.abs, s.atime, s.mtime); // 恢复原 mtime:变异窗口里没构建 dist,所以 dist 仍与 src 一致
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
  // 测试文件必须存在(缺文件会让 vitest 在该文件上"没跑"却不报红)
  for (const t of [...new Set(list.flatMap((m) => m.tests))]) {
    if (!fs.existsSync(path.join(ctx.root, t))) {
      R_.notRun(`变异用的测试文件不存在:${t}`);
      rmTmp(tmp);
      return R_.exit();
    }
  }
  const union = [...new Set(list.flatMap((m) => m.tests))];
  const baseline = (label) => {
    const v = runVitest(ctx, tmp, union);
    if (v.code === EXIT.OK) {
      R_.pass(`${label}基线为绿(${v.evaluation.passed}/${v.evaluation.total})`);
      return true;
    }
    R_.notRun(`${label}基线不是绿的,变异结果无意义:${v.why}`);
    return false;
  };
  const results = [];
  try {
    if (!baseline('变异前')) return R_.exit();
    for (const m of list) {
      const saved = [];
      let outcome;
      try {
        for (const e of m.edits) {
          const abs = path.join(ctx.root, e.file);
          if (!saved.some((s) => s.abs === abs)) {
            const st = fs.statSync(abs);
            fs.copyFileSync(abs, `${abs}.mut-bak`);
            const rec = { abs, atime: st.atime, mtime: st.mtime };
            saved.push(rec);
            pending.push(rec);
          }
          fs.writeFileSync(abs, applyEdit(fs.readFileSync(abs, 'utf8'), e.find, e.replace));
        }
        const v = runVitest(ctx, tmp, m.tests);
        if (v.code === EXIT.NOT_RUN || !v.evaluation)
          outcome = { red: false, note: `vitest 没跑起来:${v.why}` };
        else if (v.evaluation.failed === 0) outcome = { red: false, note: '测试仍为绿(变异存活)' };
        else {
          const titles = failedTitles(v.evaluation);
          const hit = titles.filter((t) => m.redTitles.some((r) => t.includes(r)));
          outcome =
            hit.length > 0
              ? {
                  red: true,
                  note: `${titles.length} 个用例变红,其中 ${hit.length} 个指向该行为:${hit
                    .slice(0, 2)
                    .map((t) => t.slice(-40))
                    .join(' | ')}`,
                }
              : {
                  red: false,
                  note: `变红了,但失败用例没有一个指向被变异的行为(${titles.length} 个)`,
                };
        }
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
    baseline('还原后');
  } finally {
    restoreAll();
    rmTmp(tmp);
  }
  const allRed = results.every((r) => r.red);
  if (flags.writeMarker) {
    if (set !== 'a24') R_.usage('--write-marker 只能与 --set a24 一起用');
    else if (only !== undefined) R_.usage('--write-marker 不能与 --ids 一起用(必须做全部核心变异)');
    else if (!allRed || results.length !== A24_IDS.length || R_.codes.length > 0)
      R_.fail(`不是 ${A24_IDS.length}/${A24_IDS.length} 变红且基线为绿,不写标记`);
    else {
      const head = spawnSync('git', ['-C', ctx.root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
      }).stdout.trim();
      const file = path.join(ctx.root, A24_MARKER);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          `head: ${head}`,
          `result: ${A24_IDS.length}/${A24_IDS.length} red`,
          ...A24_IDS.map((i) => `${i}: red`),
          '',
        ].join('\n'),
      );
      R_.info(`已写标记 ${A24_MARKER}(绑定 HEAD ${head.slice(0, 12)})`);
    }
  }
  return R_.exit();
}

await runMain(import.meta.url, 'A24', () => a24(process.argv.slice(2)));

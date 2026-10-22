// A24 生命周期功能变异抽检(与 A20 同构的人工完成项)。
//   默认:只报告标记文件状态(.state/accept/a24.done,绑定 HEAD;换了提交就作废)。
//   --run [--set a24|all] [--ids L1,L4] [--write-marker]:真的做变异——每处先 cp 备份、断言替换匹配数恰好 1、
//     跑对应 vitest 必须变红(redTitles 里至少一条用例须以**完整标题精确**变红,见 common.mjs judgeMutationRed)、cp 还原并**恢复原 mtime**;全部做完再跑一次基线必须为绿。
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
  judgeMutationRed,
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

/** edits 的 find 必须在文件里恰好出现 1 次;redTitles:预期变红用例的完整标题(vitest fullName,精确相等;判据见 common.mjs judgeMutationRed)。 */
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
    redTitles: [
      'C1 本地重扫注入 judge 说 injection_suspected=false 时本地扫描照跑:危险话术仍被拒(不作放行依据)',
      'C1 本地重扫注入 没有 judge 记录也照常扫描',
      'C1 本地重扫注入 逐字段扫描:title',
      'C1 本地重扫注入 逐字段扫描:do',
      'C1 本地重扫注入 逐字段扫描:why',
      'C1 本地重扫注入 逐字段扫描:verify',
      'C1 本地重扫注入 逐字段扫描:signature.pattern',
      'C1 本地重扫注入 逐字段扫描:evidence excerpt',
      'C1 本地重扫注入 提案 rationale 与提案侧证据摘录也扫',
      'C1 本地重扫注入 不可见字符 → HIDDEN_CHARS;多个原因都列出(不短路)',
    ],
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
    redTitles: [
      'promote --run:端到端 reflect → judge → promote --write → git apply → check --guards(kit:reflector)绿,提案含 judge',
      'promote --run:端到端 pr-body / report / stdout 不含摘录、正文、提示;写明以新 patch 为准',
      'promote --run:端到端 默认只打印:前后快照相同;--write 缺省不写 .state/promote',
      'promote --run:端到端 幂等:同输入再 --write → 退出 0 不重写;被改过的产物 → 退出 3 PROMOTE_RUN_EXISTS',
      'promote --run:端到端 上次失败遗留的 .tmp- 目录 → 退出 3,不覆盖',
      'promote --run:端到端 不同 KIT_TMP 下两次运行(同一份暂存与仓库内容)产物字节相同',
      'C6 规则文本与评审绑定 合法样例通过',
      'C6 规则文本与评审绑定 晋升后的文本仍可通过 C6(绑定的是归一化哈希)',
      'C6 规则文本与评审绑定 文本无法哈希(无 frontmatter / status 不是恰好一行)→ RULE_TEXT_UNHASHABLE',
    ],
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
    redTitles: [
      'judge 记录里的 rule_sha256 judge 成功后记录带 rule_sha256,且等于规则文件当前的 ruleSha256(正向对照:改一个字就对不上)',
      'promote --run:端到端 reflect → judge → promote --write → git apply → check --guards(kit:reflector)绿,提案含 judge',
      'promote --run:端到端 pr-body / report / stdout 不含摘录、正文、提示;写明以新 patch 为准',
      'promote --run:端到端 默认只打印:前后快照相同;--write 缺省不写 .state/promote',
      'promote --run:端到端 幂等:同输入再 --write → 退出 0 不重写;被改过的产物 → 退出 3 PROMOTE_RUN_EXISTS',
      'promote --run:端到端 上次失败遗留的 .tmp- 目录 → 退出 3,不覆盖',
      'promote --run:端到端 不同 KIT_TMP 下两次运行(同一份暂存与仓库内容)产物字节相同',
      'promote --run:逐条判据与退出码 真 judge 命令写入 rule_sha256,且等于评审时规则文本的归一化哈希(⑨A 接线)',
      'promote --run:逐条判据与退出码 C6:旧版 judge 留下的记录没有 rule_sha256 → 丢弃 C6:RULE_SHA256_MISSING',
      'promote --run:墓碑端到端(retire → 删文件 → 采纳同 id) 原子经 retire(rejected)退役、再被 G4 流程删除后,lifecycle 记录留存;采纳同 id 提案被 C7 以 ID_TOMBSTONED 拒',
    ],
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
    redTitles: [
      'promote --run:端到端 reflect → judge → promote --write → git apply → check --guards(kit:reflector)绿,提案含 judge',
    ],
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
    redTitles: [
      'T2 advisory→active attest 判据红(L2/K4 原因码):有效块不足 → G3:THRESHOLD_TILES',
      'T2 advisory→active attest 判据红(L2/K4 原因码):成员不足 → G3:THRESHOLD_TILES',
      'T2 advisory→active attest 判据红(L2/K4 原因码):曝光不足 → G3:THRESHOLD_EXPOSURE',
      'T2 advisory→active attest 判据红(L2/K4 原因码):harmful → G3:THRESHOLD_HARMFUL',
      'T2 advisory→active attest 判据红(L2/K4 原因码):成员不在名单 → G3:THRESHOLD_TILES',
      'T2 advisory→active attest 判据红(L2/K4 原因码):窗口早于 advisory → G3:THRESHOLD_TILES',
      'T2 advisory→active attest 判据红(L2/K4 原因码):没有 attest → G3:THRESHOLD_TILES',
      'T2 advisory→active THRESHOLD_TILES:只有一个有效块(14 天需要 2 块)',
      'T2 advisory→active THRESHOLD_TILES:只有一名成员(每块都不够 min_members)',
      'T2 advisory→active THRESHOLD_TILES:成员数够但全是 owner 自己(⑥A,块内非 owner 门槛)',
      'T2 advisory→active THRESHOLD_EXPOSURE:曝光合计不足',
      'T2 advisory→active THRESHOLD_HARMFUL:有效 attest 里出现 harmful>0',
    ],
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
    redTitles: [
      'T3/T4 → deprecated(manual) advisory→deprecated:--write 产物三件套(0700/0600)、补丁只改 status 并新增一条记录、应用后 check --guards --label kit:retire 绿',
      'T3/T4 → deprecated(manual) active→deprecated:--write 产物三件套(0700/0600)、补丁只改 status 并新增一条记录、应用后 check --guards --label kit:retire 绿',
    ],
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
    redTitles: [
      '墓碑参与晋升的 C7 id 在 lifecycle/<id>/ 下有记录(墓碑)→ 晋升被 C7:ID_TOMBSTONED 拒,不写;无墓碑时同一世界通过',
      'C7 id 与去重 id 在退役记录(墓碑)里 → ID_TOMBSTONED,即使原子文件已不在仓库',
      'C7 id 与去重 promote 模式:自己的 id 在仓库里不算冲突,也不与自己比相似度;墓碑照查',
    ],
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
    redTitles: [
      'T1 proposed→advisory C5 独有:JUDGE_PROVIDER_MISMATCH:judge.provider 不等于最后一跳 → 拒(CI 不得比本地 promote 宽)',
    ],
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
    redTitles: ['T1 proposed→advisory 干跑:退出 0、只算不写(前后快照相同)、JSON 键集合固定'],
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
    redTitles: [
      'A21 矩阵脚本 A21 的原因码核对会真的报错:给错原因码 / 该拒却通过 / 字段不符 / 抛异常 / 回显文本,各产生问题(正向控制)',
    ],
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
    redTitles: [
      'A22 import 图与白名单 分析器自身的对照:reflect 命令报出 llm-exec / backends;合成坏例逐种被发现;注释里的 import 不误报',
    ],
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

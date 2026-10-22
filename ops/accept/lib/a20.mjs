// A20 变异抽检(与 A13 同构的人工完成项)。
//   默认:只报告标记文件状态(.state/accept/a20.done,绑定 HEAD;换了提交就作废)。
//   --run [--set a20|all] [--write-marker]:真的做变异——每处先 cp 备份、断言替换匹配数恰好 1、跑对应 vitest 必须变红
//     (redTitles 里至少一条用例须以**完整标题精确**变红,见 common.mjs judgeMutationRed)、cp 还原;全部做完再跑一次基线必须为绿,并重新 build dist(变异期间 src 的 mtime 变了,
//     dist 会被 freshDist 判陈旧——不恢复 mtime,宁可让 A16–A19 报「未执行」也不让变异窗口里构建的 dist 冒充新鲜)。
//     进程收到 SIGINT/SIGTERM 会先还原再退出;SIGKILL 会留下 .mut-bak,下一次运行与 freshDist 都会拒绝继续。
//     --write-marker 要求工作树干净(标记只绑 HEAD,脏树上写的标记会在之后的任何改动下继续有效)。
//     --write-marker 只对 --set a20 且 6/6 都变红时写标记。变异表见 MUTATIONS;清单与做法见 ops/accept/a20-mutation.md。
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

export const A20_MARKER = path.join('.state', 'accept', 'a20.done');
export const A20_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

const R = 'test/commands/reflect.test.ts';
const WIRE = 'test/commands/wiring.test.ts';
const E2E = 'test/commands/r5-e2e.test.ts';

/** edits 的 find 必须在文件里恰好出现 1 次;redTitles:预期变红用例的完整标题(vitest fullName,精确相等;判据见 common.mjs judgeMutationRed)。 */
export const MUTATIONS = [
  // ---- A20 的六处(M1–M6)----
  {
    id: 'M1',
    a20: true,
    what: 'reflect 外部内容会话的摘录进了提示(装载不清空 + 证据资格不再排除外部内容)',
    edits: [
      {
        file: 'src/reflect/load.ts',
        find: 'if (s.external_content || externalSessions.has(s.session_ref)) {',
        replace: 'if (false) {',
      },
      {
        file: 'src/reflect/evidence.ts',
        find: '    !s.external_content &&\n',
        replace: '    true &&\n',
      },
    ],
    tests: [
      E2E,
      'test/reflect/run.test.ts',
      'test/reflect/load.test.ts',
      'test/reflect/evidence-prompt.test.ts',
    ],
    redTitles: [
      'reflect/load 外部内容摘录强制清空、失败结果摘录清空、缺结构字段的信号排除并计数',
      'reflect/load 评审后补强 会话级外部内容:先写入的非外部行,在会话后来出现外部信号时同样清空摘录',
    ],
  },
  {
    id: 'M2',
    a20: true,
    what: 'judge 与反思器同厂商的跳没被拒绝(照常调用后端)',
    edits: [
      {
        file: 'src/judge/run.ts',
        find: 'if (norm(backend.vendor) === norm(p.reflector.vendor)) {',
        replace: 'if (false) {',
      },
      {
        file: 'src/judge/run.ts',
        find: 'if (vendorUnproven(backend) || !isCrossVendor(p.reflector.vendor, backend.vendor)) {',
        replace: 'if (vendorUnproven(backend)) {',
      },
    ],
    tests: ['test/judge/run.test.ts', E2E],
    redTitles: [
      '端到端:collect → reflect → apply → check → judge 只有与反思器同厂商的一家可用:不调用,记 skipped:same-vendor,judge_attempts 记满 5 跳且不含 ok',
      'judge 兜底链 同厂商的跳不调用且记 skipped:same-vendor;下一跳成功',
      'judge 兜底链 同厂商比较归一化:后端自报 "Anthropic " 也算同厂商,不调用',
      'judge 兜底链 只有同厂商/未配置:no_cross_vendor,零调用,attempts 记满且同厂商贴 skipped:same-vendor',
    ],
  },
  {
    id: 'M3',
    a20: true,
    what: '干跑误写(干跑模式被改成会走后端失败路径、写出 report)',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: ": 'dry',\n          runId",
        replace: ": 'stub',\n          runId",
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:默认干跑 零后端构造、零调用、零写入;打印计划(正向对照:聚类/证据数 > 0)',
      'reflect 命令:默认干跑 --show-prompt:提示只打到 stdout 不落盘(正向对照:含 L1 canary;不含外部/失败结果 canary)',
      'reflect 命令:默认干跑 干跑不要求 --owner;--json 摘要只含白名单键,且不含任何摘录/提示文本',
    ],
  },
  {
    id: 'M4',
    a20: true,
    what: '状态转移绕过(合并器把新原子写成 status: active)',
    edits: [
      {
        file: 'src/reflect/merge.ts',
        find: "      status: 'proposed',",
        replace: "      status: 'active',",
      },
    ],
    tests: [E2E, R],
    redTitles: [
      '端到端:collect → reflect → apply → check → judge 完整闭环',
      'reflect 命令:真跑(注入 stub 后端) 暂存 report.json / proposals / rules / apply.patch;退出 0;stdout 只含计数与 id',
    ],
  },
  {
    id: 'M5',
    a20: true,
    what: 'egress 门:--run-llm 缺 --allow-egress 也执行',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'else if (out.runLlm && !out.allowEgress) {',
        replace: 'else if (false) {',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:egress 门与用法错 --run-llm 缺 --allow-egress → 2:工厂不构造、后端零调用、零写入(正向对照:补上后才执行)',
    ],
  },
  {
    id: 'M6',
    a20: true,
    what: 'judge 越权改提案的其它字段(落盘时多写 layer,且不变式检查被拆掉)',
    edits: [
      {
        file: 'src/judge/store.ts',
        find: '  assertOnlyJudgeKeysChanged(raw, next);\n  return next;',
        replace: "  next['layer'] = 'team';\n  return next;",
      },
    ],
    tests: ['test/judge/store.test.ts', 'test/judge/run.test.ts', E2E],
    redTitles: [
      '幂等与互斥 重复 judge:attempts 整体替换不累积,相同内容不重写;之后成功写 judge 并删除 attempts;再跑跳过',
      'judge 不越权 只改 proposals/*.yaml 的 judge 键;rules/*.md、report.json 与提案其它字段原样;accept+injection_suspected=true 也不动状态',
    ],
  },
  // ---- 其余(R5 自己的 19 处变异里不在 A20 六处之内的)----
  {
    id: 'X1',
    what: '--owner 不校验',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: '} else if (out.runLlm && out.owner === undefined) {',
        replace: '} else if (false) {',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:egress 门与用法错 --run-llm --allow-egress 缺 --owner → 2;非法 owner → 2;零调用',
    ],
  },
  {
    id: 'X2',
    what: '默认模式改成真跑',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'const live = args.runLlm && args.allowEgress;',
        replace: 'const live = true;',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:默认干跑 零后端构造、零调用、零写入;打印计划(正向对照:聚类/证据数 > 0)',
      'reflect 命令:默认干跑 --show-prompt:提示只打到 stdout 不落盘(正向对照:含 L1 canary;不含外部/失败结果 canary)',
      'reflect 命令:默认干跑 干跑不要求 --owner;--json 摘要只含白名单键,且不含任何摘录/提示文本',
      'reflect 命令:真跑(注入 stub 后端) 预算算不出来(仓库没有 kit.toml):干跑报 unknown 仍退 0;真跑 fail-closed 退 3,零调用',
    ],
  },
  {
    id: 'X3',
    what: '干跑也构造后端',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'if (live) {\n          const backends',
        replace: 'if (true) {\n          const backends',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:默认干跑 零后端构造、零调用、零写入;打印计划(正向对照:聚类/证据数 > 0)',
      'reflect 命令:默认干跑 --show-prompt:提示只打到 stdout 不落盘(正向对照:含 L1 canary;不含外部/失败结果 canary)',
      'reflect 命令:真跑(注入 stub 后端) 预算算不出来(仓库没有 kit.toml):干跑报 unknown 仍退 0;真跑 fail-closed 退 3,零调用',
    ],
  },
  {
    id: 'X4',
    what: 'unknown 厂商放行',
    edits: [
      {
        file: 'src/reflect/run.ts',
        find: 'if (b !== undefined && (!VENDOR_ID_RE.test(b.vendor) || b.vendor === UNKNOWN_VENDOR)) {',
        replace: 'if (b !== undefined && !VENDOR_ID_RE.test(b.vendor)) {',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:退出码映射 厂商 unknown → 3,后端零调用(正向对照:换成可证明厂商后才调用)',
    ],
  },
  {
    id: 'X5',
    what: '数字参数改回 Number',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'const n = parseDecimalUint(mc);',
        replace: 'const n = Number(mc);',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:egress 门与用法错 数字/枚举参数非法 ["--max-calls","0x2"] → 2(parseDecimalUint)',
      'reflect 命令:egress 门与用法错 数字/枚举参数非法 ["--max-calls","+2"] → 2(parseDecimalUint)',
      'reflect 命令:egress 门与用法错 数字/枚举参数非法 ["--max-calls"," 2"] → 2(parseDecimalUint)',
    ],
  },
  {
    id: 'X6',
    what: '退出码映射错位(调用上限 → 3)',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'if (e instanceof ReflectCallLimitError) return { code: ExitCode.NOT_RUN, reason: e.code };',
        replace:
          'if (e instanceof ReflectCallLimitError) return { code: ExitCode.FAIL_CLOSED, reason: e.code };',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:退出码映射 ReflectCallLimitError → NaN,stderr 只有稳定码、不带异常消息',
      'reflect 命令:退出码映射 批数超过 --max-calls → 4,后端零调用(放大到 3 才执行)',
    ],
  },
  {
    id: 'X7',
    what: 'team_project_keys 缺省放行团队层',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: "if (prop === 'has') return (k: string) => !whitelist.has(k);",
        replace:
          "if (prop === 'has') return (k: string) => whitelist.size > 0 && !whitelist.has(k);",
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:真跑(注入 stub 后端) team_project_keys 缺省 → 跨项目聚类也判 personal(无 apply.patch);列出两个项目 → team(fail-closed 的反面对照)',
      'reflect 命令:真跑(注入 stub 后端) personalKeysFromTeamWhitelist:has 取反;其余成员一律抛错(不留悄悄放行的空集)',
    ],
  },
  {
    id: 'X8',
    what: 'allow_unverified 缺省为真',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: '(b.allow_unverified === true) === allow',
        replace: '(b.allow_unverified !== false) === allow',
      },
    ],
    tests: [WIRE],
    redTitles: [
      'reflect 默认接线(真实 buildBackends + 假 codex) 真跑但没写 allow_unverified:参数集未核实 → 不 spawn,退出 4;写了 allow_unverified=true 才 spawn(正向对照)',
      'reflect 默认接线(真实 buildBackends + 假 codex) allow_unverified 逐槽位:两个槽位共用同一个 codex 二进制,没写的那个仍被拒',
      'judge 默认接线 真跑:覆盖层已同意但没绑任何槽位 → 4;未核实且没写 allow_unverified → 不 spawn;写了才评审成功并写 judge',
    ],
  },
  {
    id: 'X9',
    what: 'judge 默认命令在干跑时构造后端',
    edits: [
      {
        file: 'src/commands/judge.ts',
        find: 'if (!mode.live) return {};',
        replace: 'if (false) return {};',
      },
    ],
    tests: [WIRE],
    redTitles: ['judge 默认接线 干跑:不构造后端(canary 不出现),退出 0'],
  },
  {
    id: 'X10',
    what: '--json 输出含提示文本',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'includePrompt: args.showPrompt,',
        replace: 'includePrompt: true,',
      },
      {
        file: 'src/commands/reflect.ts',
        find: 'if (args.json) ctx.stdout(canonicalJson(summary));',
        replace: 'if (args.json) ctx.stdout(canonicalJson({ ...summary, p: result.prompts }));',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:默认干跑 干跑不要求 --owner;--json 摘要只含白名单键,且不含任何摘录/提示文本',
    ],
  },
  {
    id: 'X11',
    what: 'A19 快照比对被跳过',
    edits: [
      {
        file: 'ops/accept/lib/a19.mjs',
        find: 'if (b === undefined || a === undefined || b.hash !== a.hash) {',
        replace: 'if (false) {',
      },
    ],
    tests: ['test/accept/p1-ops.test.ts'],
    redTitles: ['A19 快照比对 A19 对一次真实写入报出差异;无变化时为空;删除也算差异(探测本身有效)'],
  },
  {
    id: 'X12',
    what: '预算已满仍调用后端(短路被拆掉)',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: "if (live && budget === 'full') {",
        replace: 'if (false) {',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:真跑(注入 stub 后端) 预算已满 → 真跑不调用后端(摘录不白发)、不写任何文件,退出 1;预算未满时同样的运行会调用(正向对照)',
    ],
  },
  {
    id: 'X13',
    what: '覆盖层未同意外发也放行',
    edits: [
      {
        file: 'src/commands/reflect.ts',
        find: 'if (live && !overlayAllowsEgress(overlay)) {',
        replace: 'if (false) {',
      },
    ],
    tests: [R],
    redTitles: [
      'reflect 命令:egress 门与用法错 两个 flag 都给但覆盖层未同意外发(缺覆盖层 / egress=false)→ 2,零构造零调用零写入',
    ],
  },
  {
    id: 'X14',
    what: 'A16 矩阵不再校验拒绝原因码',
    edits: [
      {
        file: 'ops/accept/lib/a16.mjs',
        find: 'if (r.code !== c.expect.code) {',
        replace: 'if (false) {',
      },
    ],
    tests: ['test/accept/p1-ops.test.ts'],
    redTitles: [
      'A16 矩阵夹具(src 上同样成立) A16 脚本的"原因码核对"会真的报错:假校验器给错原因码时,每条非法夹具都产生一条问题',
    ],
  },
];

/** 标记文件状态(同 A13):done / todo / stale / invalid。 */
export function a20Status(root) {
  const file = path.join(root, A20_MARKER);
  if (!fs.existsSync(file)) return { state: 'todo', detail: `缺 ${A20_MARKER}` };
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const head = lines.find((l) => l.startsWith('head: '))?.slice(6);
  if (!head || !/^[0-9a-f]{40}$/.test(head))
    return { state: 'invalid', detail: '标记无效(缺 head: <40 位 SHA>)' };
  if (lines.filter((l) => l === 'result: 6/6 red').length !== 1)
    return { state: 'invalid', detail: '标记无效(缺恰好一行 "result: 6/6 red")' };
  for (const id of A20_IDS) {
    if (lines.filter((l) => l === `${id}: red`).length !== 1)
      return { state: 'invalid', detail: `标记无效(缺 "${id}: red")` };
  }
  const extra = lines.filter((l) => !/^(head: |result: |M[1-6]: red$)/.test(l));
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
  return { state: 'done', detail: `6/6 red,HEAD ${head.slice(0, 12)}` };
}

/** 替换并断言匹配数恰好为 1。返回新文本;匹配数不对抛错。 */
export function applyEdit(text, find, replace) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`变异没有落到代码上:匹配 ${n} 次(应恰好 1 次)`);
  return text.replace(find, () => replace);
}

async function a20(argv) {
  const R_ = new Reporter('A20');
  const { flags } = parseCommon(argv, { bool: ['run', 'write-marker'], value: ['set', 'ids'] });
  const ctx = makeCtx(flags);
  if (!flags.run) {
    const s = a20Status(ctx.root);
    if (s.state === 'done') R_.pass(`人工完成项:${s.detail}`);
    else
      R_.notRun(
        `人工完成项未完成:${s.detail}(按 ops/accept/a20-mutation.md 做,或 --run --set a20 --write-marker)`,
      );
    return R_.exit();
  }
  const set = flags.set ?? 'a20';
  if (!['a20', 'all'].includes(set)) {
    R_.usage('--set 只能是 a20 或 all');
    return R_.exit();
  }
  const only = flags.ids ? new Set(String(flags.ids).split(',')) : undefined;
  const list = MUTATIONS.filter(
    (m) => (set === 'all' || m.a20) && (only === undefined || only.has(m.id)),
  );
  const files = [...new Set(list.flatMap((m) => m.edits.map((e) => e.file)))];
  for (const f of files) {
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
  const tmp = mkTmp(ctx, 'a20');
  const pending = [];
  const restoreAll = () => {
    for (const s of pending.splice(0)) {
      try {
        fs.copyFileSync(`${s.abs}.mut-bak`, s.abs);
        fs.rmSync(`${s.abs}.mut-bak`);
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
            fs.copyFileSync(abs, `${abs}.mut-bak`);
            const rec = { abs };
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
          fs.copyFileSync(`${s.abs}.mut-bak`, s.abs);
          fs.rmSync(`${s.abs}.mut-bak`);
          pending.splice(pending.indexOf(s), 1);
        }
      }
      results.push({ id: m.id, what: m.what, ...outcome });
      if (outcome.red) R_.pass(`${m.id} ${m.what}:变红(${outcome.note})`);
      else R_.fail(`${m.id} ${m.what}:${outcome.note}`);
    }
    baseline('还原后');
    // 重建 dist,让它和还原后的 src 一致(否则 A16–A19 会因 dist 陈旧报「未执行」)
    if (fs.existsSync(ctx.cli)) {
      const tsc = path.join(ctx.root, 'node_modules', '.bin', 'tsc');
      const b = spawnSync(tsc, ['-p', 'tsconfig.build.json'], {
        cwd: ctx.root,
        encoding: 'utf8',
        env: cleanEnv(),
      });
      if (b.status === 0) R_.info('已重新 build dist');
      else R_.notRun(`还原后重新 build 失败(退出 ${b.status}):${String(b.stdout).slice(0, 200)}`);
    }
  } finally {
    restoreAll();
    rmTmp(tmp);
  }
  const allRed = results.every((r) => r.red);
  if (flags.writeMarker) {
    if (set !== 'a20') R_.usage('--write-marker 只能与 --set a20 一起用');
    else if (!allRed || results.length !== 6 || R_.codes.length > 0)
      R_.fail('不是 6/6 变红且基线为绿,不写标记');
    else {
      const head = spawnSync('git', ['-C', ctx.root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
      }).stdout.trim();
      const file = path.join(ctx.root, A20_MARKER);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [`head: ${head}`, 'result: 6/6 red', ...A20_IDS.map((i) => `${i}: red`), ''].join('\n'),
      );
      R_.info(`已写标记 ${A20_MARKER}(绑定 HEAD ${head.slice(0, 12)})`);
    }
  }
  return R_.exit();
}

await runMain(import.meta.url, 'A20', () => a20(process.argv.slice(2)));

// A18 judge 的厂商分离与记账:对 dist 的 runJudge 用进程内 stub 后端跑合成 run 目录,**读盘回来**核对。
//  - 与反思器同厂商的跳**不调用**(stub 调用数 = 0),记 skipped:same-vendor;
//  - 全链都没评上时不写 judge,改写 judge_attempts:恰好 5 跳、顺序 = 兜底链、不含 ok;
//  - 防假绿:合法对照(跨厂商那一跳恰好被调用 1 次、写出 judge)先过;hops/调用数都用精确相等;
//    不联网、不 spawn(后端全是进程内对象);先查 dist 不陈旧。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Reporter, makeCtx, mkTmp, parseCommon, rmTmp, runMain } from './common.mjs';
import { freshDist, importDist } from './accept-p1.mjs';
import { kitToml } from './lc-world.mjs';

export const CHAIN = ['codex', 'maas-deepseek', 'glm', 'kimi', 'official-deepseek'];
const VENDOR = {
  codex: ['openai', 'gpt-example'],
  'maas-deepseek': ['deepseek', 'deepseek-example'],
  glm: ['zhipu', 'glm-example'],
  kimi: ['moonshot', 'kimi-example'],
  'official-deepseek': ['deepseek', 'deepseek-example-2'],
};
export const OK_TEXT = JSON.stringify({
  verdict: 'accept',
  overfit_risk: 'low',
  generality: 'high',
  volatile: false,
  conflicts: [],
  injection_suspected: false,
  notes: 'looks fine',
});
export const RUN_ID = 'run-a18';

export const proposalYaml = (yaml, over) =>
  yaml.stringify(
    {
      id: '2026-10-12-001',
      op: 'add',
      targets: ['new-rule-a'],
      layer: 'personal',
      rationale: 'A18 合成提案',
      evidence: [
        { sig: 'sig_0123456789abcdef', project_key: 'p_fedcba9876543210', excerpt: 'A18 合成摘录' },
      ],
      budget_delta_bytes: 10,
      paired_retirements: [],
      cases: [],
      reflector: {
        provider: over.provider,
        vendor: over.vendor,
        model: over.model ?? 'reflector-model',
        run_id: RUN_ID,
        backend: over.backend,
        prompt_id: 'reflect-v1',
        stub: true,
      },
    },
    { lineWidth: 0 },
  );

export const ruleMd = () =>
  `---
id: new-rule-a
title: A18 合成规则
layer: personal
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@owner-handle'
created: 2026-10-12
review_by: 2026-11-12
signature:
  type: phrase
  pattern: a18-pattern
evidence:
  - type: trace
    ref: sig_0123456789abcdef
    excerpt: A18 合成摘录
verifier:
  type: none
---

**做**:A18 做。
**为什么**:A18 为什么。
**怎么验**:A18 怎么验。
`;

/** 场景:reflector 厂商 + 各跳脚本。script: 'ok' | 'fail' | 'unknown-vendor'(厂商不可证明) */
export const SCENARIOS = [
  {
    name: 'S0 合法对照:跨厂商的 codex 被调用 1 次并写出 judge',
    reflector: { vendor: 'anthropic', provider: 'anthropic', backend: 'claude' },
    scripts: { codex: 'ok' },
    hops: [['codex', 'ok']],
    calls: { codex: 1, 'maas-deepseek': 0, glm: 0, kimi: 0, 'official-deepseek': 0 },
    kind: 'judge',
  },
  {
    name: 'S1 首跳与反思器同厂商:不调用、记 skipped:same-vendor,下一跳评上',
    reflector: { vendor: 'openai', provider: 'openai', backend: 'codex' },
    scripts: { codex: 'ok', 'maas-deepseek': 'ok' },
    hops: [
      ['codex', 'skipped:same-vendor'],
      ['maas-deepseek', 'ok'],
    ],
    calls: { codex: 0, 'maas-deepseek': 1, glm: 0, kimi: 0, 'official-deepseek': 0 },
    kind: 'judge',
  },
  {
    name: 'S2 反思器是 deepseek 系:两个 deepseek 跳不调用,其余失败 → judge_attempts 记满 5 跳',
    reflector: { vendor: 'deepseek', provider: 'deepseek', backend: 'pi', model: 'deepseek-r' },
    scripts: {
      codex: 'fail',
      'maas-deepseek': 'ok',
      glm: 'fail',
      kimi: 'fail',
      'official-deepseek': 'ok',
    },
    attempts: [
      ['codex', 'error:error'],
      ['maas-deepseek', 'skipped:same-vendor'],
      ['glm', 'error:error'],
      ['kimi', 'error:error'],
      ['official-deepseek', 'skipped:same-vendor'],
    ],
    calls: { codex: 1, 'maas-deepseek': 0, glm: 1, kimi: 1, 'official-deepseek': 0 },
    kind: 'attempts',
  },
  {
    name: 'S3 全链失败(无同厂商):5 跳都调用 1 次,judge_attempts 全是 error,不含 ok',
    reflector: { vendor: 'anthropic', provider: 'anthropic', backend: 'claude' },
    scripts: {
      codex: 'fail',
      'maas-deepseek': 'fail',
      glm: 'fail',
      kimi: 'fail',
      'official-deepseek': 'fail',
    },
    attempts: CHAIN.map((h) => [h, 'error:error']),
    calls: { codex: 1, 'maas-deepseek': 1, glm: 1, kimi: 1, 'official-deepseek': 1 },
    kind: 'attempts',
  },
  {
    name: 'S4 某跳厂商不可证明(unknown):不调用,记 error:vendor_unknown',
    reflector: { vendor: 'anthropic', provider: 'anthropic', backend: 'claude' },
    scripts: {
      codex: 'unknown-vendor',
      'maas-deepseek': 'fail',
      glm: 'fail',
      kimi: 'fail',
      'official-deepseek': 'fail',
    },
    attempts: [
      ['codex', 'error:vendor_unknown'],
      ['maas-deepseek', 'error:error'],
      ['glm', 'error:error'],
      ['kimi', 'error:error'],
      ['official-deepseek', 'error:error'],
    ],
    calls: { codex: 0, 'maas-deepseek': 1, glm: 1, kimi: 1, 'official-deepseek': 1 },
    kind: 'attempts',
  },
];

/** 在 `<state>/reflect/run-a18/` 下写一个合成的 reflect 暂存 run(提案 + 规则 + report),并在仓库里放一个已知原子占位。 */
export function writeRunDir(yaml, repo, state, reflector) {
  const runDir = path.join(state, 'reflect', RUN_ID);
  fs.mkdirSync(path.join(repo, 'rules', 'org'), { recursive: true });
  // judge 冻结参数读 <repo>/kit.toml(缺失即 fail-closed JUDGE_STATE_INVALID);验收不能依赖运行环境里碰巧有它
  fs.writeFileSync(path.join(repo, 'kit.toml'), kitToml());
  fs.writeFileSync(path.join(repo, 'rules', 'org', 'known-rule.md'), 'placeholder\n');
  fs.mkdirSync(path.join(runDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'rules', 'personal'), { recursive: true });
  const propFile = path.join(runDir, 'proposals', '2026-10-12-001.yaml');
  fs.writeFileSync(propFile, proposalYaml(yaml, reflector));
  fs.writeFileSync(path.join(runDir, 'rules', 'personal', 'new-rule-a.md'), ruleMd());
  fs.writeFileSync(path.join(runDir, 'report.json'), '{}\n');
  return { runDir, propFile };
}

export async function runScenario(mods, tmp, sc, idx) {
  const { paths, judgeRun, yaml, redact } = mods;
  const dir = path.join(tmp, `s${idx}`);
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  const { propFile } = writeRunDir(yaml, repo, state, sc.reflector);
  const io = paths.createIoContext({
    cwd: repo,
    root: repo,
    env: { KIT_TMP: dir, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  const calls = {};
  const backends = {};
  for (const hop of CHAIN) {
    calls[hop] = 0;
    const script = sc.scripts[hop];
    if (script === undefined) continue;
    const [vendor, model] = script === 'unknown-vendor' ? ['unknown', 'mystery'] : VENDOR[hop];
    backends[hop] = {
      slot: hop,
      vendor,
      model,
      async complete() {
        calls[hop]++;
        return script === 'ok' ? { ok: true, text: OK_TEXT } : { ok: false, reason: 'error' };
      },
    };
  }
  const before = fs.readFileSync(propFile, 'utf8');
  await judgeRun.runJudge(
    {
      io,
      redactor: redact.createRedactor({ timeout_ms: 5000 }),
      backends,
      // 冻结记录需要仓库 HEAD 与时钟:合成 run 目录不是 git 仓库,注入固定值(不依赖 git/系统时钟/用户名)
      resolveHead: () => '0123456789abcdef0123456789abcdef01234567',
      now: () => new Date('2026-10-12T08:00:00Z'),
    },
    { runId: RUN_ID, dry: false, maxCalls: 10 },
  );
  const after = yaml.parse(fs.readFileSync(propFile, 'utf8'));
  const orig = yaml.parse(before);
  return { calls, after, orig };
}

export function judgeScenario(sc, r) {
  const problems = [];
  if (JSON.stringify(r.calls) !== JSON.stringify(sc.calls))
    problems.push(`stub 调用数应为 ${JSON.stringify(sc.calls)},实际 ${JSON.stringify(r.calls)}`);
  const { judge, judge_attempts: attempts, ...rest } = r.after;
  const origRest = { ...r.orig };
  delete origRest.judge;
  delete origRest.judge_attempts;
  if (JSON.stringify(rest) !== JSON.stringify(origRest))
    problems.push('提案的其它字段被改动(judge 只许写 judge / judge_attempts)');
  if (sc.kind === 'judge') {
    if (judge === undefined) problems.push('应写出 judge');
    else if (JSON.stringify(judge.hops.map((h) => [h.hop, h.result])) !== JSON.stringify(sc.hops))
      problems.push(
        `judge.hops 应为 ${JSON.stringify(sc.hops)},实际 ${JSON.stringify(judge.hops.map((h) => [h.hop, h.result]))}`,
      );
    if (judge !== undefined && judge.provider !== sc.hops[sc.hops.length - 1][0])
      problems.push('judge.provider 应等于最后一跳');
    if (attempts !== undefined) problems.push('评上了就不应留 judge_attempts');
  } else {
    if (judge !== undefined) problems.push('全链没评上,不应写 judge');
    if (attempts === undefined) problems.push('应写 judge_attempts');
    else {
      const got = attempts.map((h) => [h.hop, h.result]);
      if (JSON.stringify(got) !== JSON.stringify(sc.attempts))
        problems.push(
          `judge_attempts 应为 ${JSON.stringify(sc.attempts)},实际 ${JSON.stringify(got)}`,
        );
      if (attempts.length !== 5)
        problems.push(`judge_attempts 应记满 5 跳,实际 ${attempts.length}`);
      if (attempts.some((h) => h.result === 'ok')) problems.push('judge_attempts 不应含 ok');
    }
  }
  return problems;
}

async function a18(argv) {
  const R = new Reporter('A18');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);
  const fresh = freshDist(ctx);
  if (!fresh.ok) {
    R.notRun(fresh.why);
    return R.exit();
  }
  const mods = {
    paths: await importDist(ctx, 'io/paths.js'),
    judgeRun: await importDist(ctx, 'judge/run.js'),
    redact: await importDist(ctx, 'redact/index.js'),
    yaml: await import('yaml'),
  };
  const tmp = mkTmp(ctx, 'a18');
  try {
    let i = 0;
    for (const sc of SCENARIOS) {
      let problems;
      try {
        problems = judgeScenario(sc, await runScenario(mods, tmp, sc, i++));
      } catch (e) {
        R.notRun(
          `${sc.name}:judge 没能运行(${e?.constructor?.name ?? 'Error'}: ${String(e?.message).slice(0, 120)})`,
        );
        continue;
      }
      if (problems.length === 0) R.pass(sc.name);
      else for (const p of problems) R.fail(`${sc.name}:${p}`);
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A18', () => a18(process.argv.slice(2)));

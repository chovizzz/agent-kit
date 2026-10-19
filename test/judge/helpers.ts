import * as path from 'node:path';
import { stringify } from 'yaml';
import type { CommandContext } from '../../src/commands/types.js';
import { JUDGE_HOP_CHAIN } from '../../src/contracts/proposal.js';
import type { JudgeHopId } from '../../src/contracts/proposal.js';
import { runSync } from '../../src/io/exec.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { readBytes, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import type { JudgeBackends } from '../../src/judge/run.js';
import { createRedactor } from '../../src/redact/redactor.js';
import type {
  LlmBackend,
  LlmCompleteRequest,
  LlmCompleteResult,
} from '../../src/reflect/backend-iface.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../helpers/tmp.js';

export const RUN_ID = 'run-0001';

/** 用到 redactor 的断言显式传 timeout_ms: 5000(机器负载高时默认 50ms 会误超时) */
export const redactor = createRedactor({ timeout_ms: 5000 });

/** 运行时拼装的假口令(仓库里不存在完整字面量,A10) */
export const fakeKeyLike = (): string => `sk-${'a1'.repeat(22)}`;

export const VALID_OUTPUT = {
  verdict: 'accept',
  overfit_risk: 'low',
  generality: 'high',
  volatile: false,
  conflicts: [] as string[],
  injection_suspected: false,
  notes: 'looks fine',
};
export const outputText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID_OUTPUT, ...over });

export type Script = (req: LlmCompleteRequest, callNo: number) => LlmCompleteResult;

/** 进程内假后端:记录每次调用收到的请求;不 spawn、不联网。 */
export class StubBackend implements LlmBackend {
  readonly calls: LlmCompleteRequest[] = [];
  constructor(
    readonly slot: string,
    readonly vendor: string,
    readonly model: string,
    private readonly script: Script = () => ({ ok: true, text: outputText() }),
  ) {}
  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    this.calls.push(req);
    return this.script(req, this.calls.length);
  }
}

export const HOP_VENDORS: Record<JudgeHopId, { vendor: string; model: string }> = {
  codex: { vendor: 'openai', model: 'gpt-example' },
  'maas-deepseek': { vendor: 'deepseek', model: 'deepseek-example' },
  glm: { vendor: 'zhipu', model: 'glm-example' },
  kimi: { vendor: 'moonshot', model: 'kimi-example' },
  'official-deepseek': { vendor: 'deepseek', model: 'deepseek-example-2' },
};

export interface Stubs {
  readonly backends: JudgeBackends;
  readonly byHop: Record<JudgeHopId, StubBackend>;
  totalCalls(): number;
}

/** 五跳齐全的假后端;scripts 按槽位覆盖行为。 */
export function makeStubs(
  scripts: Partial<Record<JudgeHopId, Script>> = {},
  only?: readonly JudgeHopId[],
): Stubs {
  const byHop = {} as Record<JudgeHopId, StubBackend>;
  const backends: Partial<Record<JudgeHopId, LlmBackend>> = {};
  for (const hop of JUDGE_HOP_CHAIN) {
    const { vendor, model } = HOP_VENDORS[hop];
    byHop[hop] = new StubBackend(hop, vendor, model, scripts[hop]);
    if (only === undefined || only.includes(hop)) backends[hop] = byHop[hop];
  }
  return {
    backends,
    byHop,
    totalCalls: () => JUDGE_HOP_CHAIN.reduce((n, h) => n + byHop[h].calls.length, 0),
  };
}

export const fail =
  (reason: 'not_installed' | 'not_configured' | 'rate_limited' | 'timeout' | 'error'): Script =>
  () => ({ ok: false, reason });
export const okWith =
  (text: string): Script =>
  () => ({ ok: true, text });

export interface Work {
  readonly dir: string;
  readonly repo: string;
  readonly state: string;
  readonly io: IoContext;
  readonly runDir: string;
  /** repo 的 HEAD 提交 oid(newWork 里真 git init + 提交了 kit.toml 与一份规则,judge 默认经 git 取 HEAD) */
  readonly head: string;
}

/** 固定的 judge 时钟:大于夹具里 guidance.until(见 GUIDANCE),便于逐字段断言 */
export const FROZEN_NOW = new Date('2026-10-14T05:40:00Z');
export const fixedNow = (): Date => FROZEN_NOW;

/** 夹具引导窗口落账:基线充足(sessions 412 ≥ 20,曝光 37 ≥ 3)→ status=predicted */
export const GUIDANCE = {
  since: '2026-09-01',
  until: '2026-10-14T03:12:00Z',
  baseline: { sessions_total: 412, exposure_sessions: 37, fired: 51 },
} as const;

/** 合法 prediction 输出(down,[0.25,0.8],0.7) */
export const VALID_PREDICTION = {
  direction: 'down',
  ratio_lo: 0.25,
  ratio_hi: 0.8,
  confidence: 0.7,
} as const;

const GIT_IDENT = [
  '-c',
  'user.name=kit-test',
  '-c',
  'user.email=kit-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
] as const;

export async function newWork(prefix = 'judge-'): Promise<Work> {
  const { dir } = await makeTempDir(prefix);
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: repo,
    env: { KIT_TMP: dir, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  await safe.mkdirp(io, path.join(repo, 'rules', 'org'));
  await safe.writeFile(io, path.join(repo, 'rules', 'org', 'known-rule.md'), 'placeholder\n');
  // judge 现在读 kit.toml [lifecycle] 并取仓库 HEAD:夹具放一份真 kit.toml 并真提交一次
  await safe.writeFile(
    io,
    path.join(repo, 'kit.toml'),
    await readText(path.join(REPO_ROOT, 'kit.toml')),
  );
  const wctx = wideCtx(dir);
  const env = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: dir,
    GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z',
  };
  const git = (args: readonly string[]): string => {
    const r = runSync(wctx, 'git', [...GIT_IDENT, ...args], { cwd: repo, env });
    if (r.spawnError !== undefined || r.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败:${r.spawnError ?? r.stderr}`);
    }
    return r.stdout;
  };
  git(['init', '--quiet', '--template=']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture']);
  const head = git(['rev-parse', 'HEAD']).trim();
  return { dir, repo, state, io, runDir: path.join(state, 'reflect', RUN_ID), head };
}

export const CANARY = {
  rationale: 'CANARY_RATIONALE_41aa',
  sig: 'sig_0123456789abcdef',
  project: 'p_fedcba9876543210',
  reflectorPrompt: 'CANARY_REFLECTOR_PROMPT_73bc',
  toolFail: 'CANARY_TOOL_FAIL_91cd',
  title: 'CANARY_TITLE_55ef',
  model: 'claude-canary-model',
  do: 'CANARY_DO_ok1',
  why: 'CANARY_WHY_ok2',
  verify: 'CANARY_VERIFY_ok3',
  excerpt: 'CANARY_EXCERPT_ok4',
  pattern: 'CANARY_PATTERN_ok5',
} as const;

export interface ProposalSpec {
  readonly id?: string;
  readonly target?: string;
  readonly layer?: 'personal' | 'team';
  readonly reflectorVendor?: string;
  /** null = 不写 backend 字段 */
  readonly reflectorBackend?: 'claude' | 'codex' | 'pi' | null;
  readonly reflectorModel?: string;
  readonly excerpts?: readonly string[];
  readonly doText?: string;
  readonly extra?: Record<string, unknown>;
  readonly runId?: string;
  /** reflector.guidance;缺省 = 不写(旧暂存提案) */
  readonly guidance?: Record<string, unknown>;
  /** 规则签名类型;缺省 phrase */
  readonly signature?: 'phrase' | 'tool' | 'path' | 'always' | 'none';
}

export function proposalObject(spec: ProposalSpec = {}): Record<string, unknown> {
  const id = spec.id ?? '2026-10-12-001';
  return {
    id,
    op: 'add',
    targets: [spec.target ?? 'new-rule-a'],
    layer: spec.layer ?? 'personal',
    rationale: CANARY.rationale,
    evidence: (spec.excerpts ?? [CANARY.excerpt]).map((excerpt) => ({
      sig: CANARY.sig,
      project_key: CANARY.project,
      excerpt,
    })),
    budget_delta_bytes: 10,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: { claude: 'anthropic', codex: 'openai', pi: 'deepseek' }[
        spec.reflectorBackend ?? 'claude'
      ],
      vendor: spec.reflectorVendor ?? 'anthropic',
      model: spec.reflectorModel ?? CANARY.model,
      run_id: spec.runId ?? RUN_ID,
      ...(spec.reflectorBackend === null ? {} : { backend: spec.reflectorBackend ?? 'claude' }),
      prompt_id: 'reflect-v1',
      stub: true,
      ...(spec.guidance !== undefined ? { guidance: spec.guidance } : {}),
    },
    ...spec.extra,
  };
}

function signatureYaml(kind: NonNullable<ProposalSpec['signature']>): string {
  switch (kind) {
    case 'none':
      return '';
    case 'always':
      return 'signature:\n  type: always\n';
    case 'path':
      return 'signature:\n  type: path\n  pattern: src/**\n';
    case 'tool':
      return `signature:\n  type: tool\n  pattern: ${CANARY.pattern}\n`;
    case 'phrase':
      return `signature:\n  type: phrase\n  pattern: ${CANARY.pattern}\n`;
  }
}

export function ruleMarkdown(spec: ProposalSpec = {}): string {
  const target = spec.target ?? 'new-rule-a';
  return `---
id: ${target}
title: ${CANARY.title}
layer: ${spec.layer ?? 'personal'}
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@owner-handle'
created: 2026-10-12
review_by: 2026-11-12
${signatureYaml(spec.signature ?? 'phrase')}evidence:
  - type: trace
    ref: ${CANARY.sig}
    excerpt: ${CANARY.excerpt}
verifier:
  type: none
---

**做**:${spec.doText ?? CANARY.do}
**为什么**:${CANARY.why}
**怎么验**:${CANARY.verify}
`;
}

/** 写一个提案 + 对应规则文件 + 一份带“反思器提示/失败工具结果”的诱饵 report。 */
export async function writeProposal(w: Work, spec: ProposalSpec = {}): Promise<string> {
  const obj = proposalObject(spec);
  const file = path.join(w.runDir, 'proposals', `${obj['id'] as string}.yaml`);
  await safe.mkdirp(w.io, path.dirname(file));
  await safe.writeFile(w.io, file, stringify(obj, { lineWidth: 0 }), { mode: 0o600 });
  const layer = spec.layer ?? 'personal';
  const rule = path.join(w.runDir, 'rules', layer, `${spec.target ?? 'new-rule-a'}.md`);
  await safe.mkdirp(w.io, path.dirname(rule));
  await safe.writeFile(w.io, rule, ruleMarkdown(spec), { mode: 0o600 });
  await safe.writeFile(
    w.io,
    path.join(w.runDir, 'report.json'),
    JSON.stringify({ prompt: CANARY.reflectorPrompt, tool_result: CANARY.toolFail }),
    { mode: 0o600 },
  );
  return file;
}

/** run 目录全部文件 → 内容(用于“零写入/只变 proposals”断言) */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory) await walk(p);
      else out[path.relative(dir, p)] = Buffer.from(await readBytes(p)).toString('utf8');
    }
  };
  await walk(dir);
  return out;
}

export async function readText2(file: string): Promise<string> {
  return readText(file);
}

export function cmdCtx(
  w: Work,
  argv: string[],
): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      argv,
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
    out,
    err,
  };
}

/**
 * run 目录(`.state/reflect/<run_id>/`)的读取与提案原地更新。
 * 读:只经 read-fs;写:只经 safe-fs,且只写 `proposals/<id>.yaml`(临时文件 + rename,0600)。
 * `rules/**`、`report.json` 等其它文件 judge 一律不碰。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { stringify } from 'yaml';
import { parseAtom } from '../atoms/parse.js';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { LayerSchema } from '../contracts/atom.js';
import { RunIdSchema } from '../contracts/common.js';
import { ProposalSchema } from '../contracts/proposal.js';
import type { Proposal, ReflectorGuidance } from '../contracts/proposal.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readText } from '../io/read-fs.js';
import { chmod, remove, rename, writeFile } from '../io/safe-fs.js';
import { JudgeStateError } from './errors.js';

/** 写出口,可注入(测试用它观察「先写临时文件再 rename」)。 */
export interface StoreFs {
  remove(io: IoContext, target: string): Promise<void>;
  writeFile(io: IoContext, target: string, data: string, opts: { mode: number }): Promise<void>;
  chmod(io: IoContext, target: string, mode: number): Promise<void>;
  rename(io: IoContext, from: string, to: string): Promise<void>;
}
export const SAFE_STORE_FS: StoreFs = { writeFile, chmod, rename, remove };

export interface LoadedProposal {
  readonly file: string;
  /** 读取时的文件原文;写回前重读比对,被改过就中止 */
  readonly text: string;
  readonly proposal: Proposal;
  /** 引导窗口落账(`reflector.guidance`);旧暂存提案没有它 → undefined(judge 据此把 status 定为 baseline_insufficient,不拒) */
  readonly guidance: ReflectorGuidance | undefined;
  /** 规则文件原文(供 judge 写入 rule_sha256:评审结论绑定评审时的规则文本,契约 ⑨A) */
  readonly ruleText: string;
  /** yaml 解析出的原始对象(保持键序),更新时在它上面改 */
  readonly raw: Record<string, unknown>;
  /** 规则文件解析出的评审输入(do/why/verify/signature) */
  readonly rule: {
    readonly do: string;
    readonly why: string;
    readonly verify: string;
    readonly signature: { type: string; pattern?: string | undefined } | undefined;
  };
}

export function runDir(io: IoContext, runId: string): string {
  return path.join(io.stateDir, 'reflect', runId);
}

/** run_id 不合法或目录不存在:用法错误(命令退出 2)。 */
export class JudgeRunNotFoundError extends Error {
  readonly code = 'JUDGE_RUN_NOT_FOUND';
}

async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function bad(why: string): never {
  throw new JudgeStateError(`JUDGE_STATE_INVALID: ${why}`);
}

async function readRegular(file: string, what: string): Promise<string> {
  let st;
  try {
    st = await lstat(file);
  } catch {
    return bad(`${what} 不存在`);
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) return bad(`${what} 不是普通文件`);
  return readText(file);
}

/** 读取一个 run 里的提案:支持评审的(`op = add` 单目标)与不支持的提案 id(N4i-5:`judge --ingest` 要区分 `proposal_unsupported`) */
export interface RunEntries {
  readonly loaded: LoadedProposal[];
  /** 通过 ProposalSchema 但不是 `op = add` 单目标的提案 id(升序;没有加载其规则文件) */
  readonly unsupported: string[];
}

/**
 * 读取一个 run 里的全部提案(按文件名排序)。任一文件损坏即整体中止;**不支持的提案不抛**而是记入 `unsupported`
 * ({@link loadRun} 保持原行为:有不支持的提案即整体中止)。
 */
export async function loadRunEntries(io: IoContext, runId: string): Promise<RunEntries> {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new JudgeRunNotFoundError('JUDGE_RUN_NOT_FOUND: run_id 不合法');
  }
  const dir = runDir(io, runId);
  if (!(await isRealDir(dir))) {
    throw new JudgeRunNotFoundError('JUDGE_RUN_NOT_FOUND: 运行目录不存在');
  }
  const propDir = path.join(dir, 'proposals');
  if (!(await isRealDir(propDir))) return bad('proposals/ 目录缺失');
  const names = (await readDir(propDir)).filter((e) => e.name.endsWith('.yaml'));
  const out: LoadedProposal[] = [];
  const unsupported: string[] = [];
  for (const e of names) {
    if (!e.isFile || e.isSymbolicLink) return bad('proposals/ 下有非普通文件');
    const file = path.join(propDir, e.name);
    const text = await readRegular(file, '提案文件');
    const y = parseRestrictedYaml(text, `proposals/${e.name}`, 'JUDGE_PROPOSAL_YAML');
    if (!y.ok) return bad('提案 yaml 无法解析');
    if (typeof y.value !== 'object' || y.value === null || Array.isArray(y.value)) {
      return bad('提案 yaml 不是对象');
    }
    const parsed = ProposalSchema.safeParse(y.value);
    if (!parsed.success) return bad('提案未通过 ProposalSchema');
    const proposal = parsed.data;
    if (e.name !== `${proposal.id}.yaml`) return bad('提案文件名与 id 不一致');
    if (proposal.op !== 'add' || proposal.targets.length !== 1) {
      unsupported.push(proposal.id);
      continue;
    }
    const target = proposal.targets[0] as string;
    for (const d of [path.join(dir, 'rules'), path.join(dir, 'rules', proposal.layer)]) {
      if (!(await isRealDir(d))) return bad('rules/ 目录缺失或是符号链接');
    }
    const rulePath = path.join(dir, 'rules', proposal.layer, `${target}.md`);
    const src = await readRegular(rulePath, '规则文件');
    const parsedAtom = parseAtom(src, `rules/${proposal.layer}/${target}.md`);
    if (!parsedAtom.atom) return bad('规则文件无法解析为原子');
    const { fm, body } = parsedAtom.atom;
    if (fm.id !== target || fm.layer !== proposal.layer) return bad('规则文件与提案的 id/层不一致');
    out.push({
      file,
      text,
      proposal,
      guidance: proposal.reflector.guidance,
      ruleText: src,
      raw: { ...(y.value as Record<string, unknown>) },
      rule: {
        do: body.do,
        why: body.why,
        verify: body.verify,
        signature: fm.signature,
      },
    });
  }
  return { loaded: out, unsupported };
}

/** 读取一个 run 里的全部提案(按文件名排序)。任一文件损坏、或有不是 `op = add` 单目标的提案,即整体中止。 */
export async function loadRun(io: IoContext, runId: string): Promise<LoadedProposal[]> {
  const { loaded, unsupported } = await loadRunEntries(io, runId);
  if (unsupported.length > 0) return bad('只支持 op=add 且单目标的提案');
  return loaded;
}

const JUDGE_KEYS = ['judge', 'judge_attempts'] as const;

/**
 * 产出更新后的提案:只替换 `judge` / `judge_attempts` 两个键,其余键原样保留。
 * judge 与 judge_attempts 互斥:写其中一个就删除另一个。
 */
export function applyJudgeFields(
  raw: Readonly<Record<string, unknown>>,
  fields: { judge: unknown } | { judge_attempts: unknown },
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(JUDGE_KEYS as readonly string[]).includes(k)) next[k] = v;
  }
  Object.assign(next, fields);
  assertOnlyJudgeKeysChanged(raw, next);
  return next;
}

/** 不变量:judge 永远不改提案的其它任何字段。 */
export function assertOnlyJudgeKeysChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if ((JUDGE_KEYS as readonly string[]).includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      bad('更新会改动 judge/judge_attempts 以外的字段');
    }
  }
}

const INGEST_ROOT_KEYS = ['judge', 'judge_attempts', 'reflector'] as const;

/**
 * N4(R20-18.31 ⑥):`judge --ingest` / `--confirm-reflector` 的写原语。与 {@link applyJudgeFields} 的区别:多允许一个键
 * `reflector.confirmed`;**只许改 `judge`、`judge_attempts`、`reflector.confirmed` 三处**,`reflector` 的其余字段
 * (`vendor` 须保持 `unknown`、`model` 须保持 `undeclared`、`provenance` 等)改动即抛 {@link JudgeStateError}。
 * - `judge` 给了:写 `judge` 并删除 `judge_attempts`(与补跑成功语义一致);
 * - `confirmed` 给了:`reflector` 里只替换 / 追加 `confirmed` 一个键,其余字段与键序原样保留。
 */
export function applyIngestFields(
  raw: Readonly<Record<string, unknown>>,
  fields: { judge?: unknown; confirmed?: unknown },
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'judge' && fields.judge !== undefined) continue;
    if (k === 'judge_attempts' && fields.judge !== undefined) continue;
    if (k === 'reflector' && fields.confirmed !== undefined) {
      const r = v as Record<string, unknown>;
      next[k] = { ...r, confirmed: fields.confirmed };
      continue;
    }
    next[k] = v;
  }
  if (fields.judge !== undefined) next['judge'] = fields.judge;
  assertOnlyIngestKeysChanged(raw, next);
  return next;
}

/** 不变量:ingest 写原语永远不改提案的其它字段,也不改 `reflector` 里 `confirmed` 以外的任何字段。 */
export function assertOnlyIngestKeysChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if ((INGEST_ROOT_KEYS as readonly string[]).includes(k) && k !== 'reflector') continue;
    if (k === 'reflector') {
      const b = before[k];
      const a = after[k];
      if (typeof b !== 'object' || b === null || typeof a !== 'object' || a === null) {
        bad('更新会改动 reflector 以外的结构');
      }
      const strip = (o: object): Record<string, unknown> => {
        const { confirmed: _c, ...rest } = o as Record<string, unknown>;
        void _c;
        return rest;
      };
      if (JSON.stringify(strip(b as object)) !== JSON.stringify(strip(a as object))) {
        bad('更新会改动 reflector.confirmed 以外的 reflector 字段');
      }
      continue;
    }
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      bad('更新会改动 judge/judge_attempts/reflector.confirmed 以外的字段');
    }
  }
}

/** 序列化并做 yaml 往返比对;不一致抛 JudgeStateError。调用前预检也用它。 */
export function serializeProposal(next: Readonly<Record<string, unknown>>): string {
  const text = stringify(next, { lineWidth: 0 });
  const back = parseRestrictedYaml(text, 'proposal', 'JUDGE_PROPOSAL_YAML');
  if (!back.ok || JSON.stringify(back.value) !== JSON.stringify(next)) {
    return bad('提案 yaml 往返不一致');
  }
  return text;
}

/**
 * 校验后原子写回:先写同目录唯一名的临时文件(0600),再 rename 覆盖;失败时清掉临时文件。
 * 写回前重读目标,与加载时的原文不同(被人或别的进程改过)→ 中止,不覆盖。
 * 假设单进程写入(无文件锁),与信号库、盐的约定一致。
 */
export async function writeProposal(
  io: IoContext,
  file: string,
  next: Readonly<Record<string, unknown>>,
  expectedText: string,
  fsx: StoreFs = SAFE_STORE_FS,
): Promise<void> {
  const parsed = ProposalSchema.safeParse(next);
  if (!parsed.success) return bad('更新后的提案未通过 ProposalSchema');
  const text = serializeProposal(next);
  if ((await readRegular(file, '提案文件')) !== expectedText) {
    return bad('提案文件在评审期间被改动');
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsx.writeFile(io, tmp, text, { mode: 0o600 });
    await fsx.chmod(io, tmp, 0o600);
    await fsx.rename(io, tmp, file);
  } catch (e) {
    await fsx.remove(io, tmp).catch(() => undefined);
    throw e;
  }
}

/** 已知原子 id:仓库 `rules/<layer>/*.md` 的文件名 + 本 run 暂存的规则。读不到的目录当空。 */
export async function loadKnownAtomIds(io: IoContext, runId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const roots = [path.join(io.repoRoot, 'rules'), path.join(runDir(io, runId), 'rules')];
  for (const root of roots) {
    for (const layer of LayerSchema.options) {
      let entries;
      try {
        entries = await readDir(path.join(root, layer));
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile && e.name.endsWith('.md')) ids.add(e.name.slice(0, -3));
      }
    }
  }
  return ids;
}

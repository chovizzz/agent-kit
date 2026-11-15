/**
 * run 目录(`.state/reflect/<run_id>/`)的**只读**读取(从 `store.ts` 原样拆出,装配块 A 段):读侧闭包不得含 safe-fs 等写出口,所以读与写分文件;
 * `store.ts` 再导出本文件的全部名字,既有调用点不变。只经 read-fs。
 */
import * as path from 'node:path';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { parseAtom } from '../atoms/parse.js';
import { RunIdSchema } from '../contracts/common.js';
import { ProposalSchema } from '../contracts/proposal.js';
import type { Proposal, ReflectorGuidance } from '../contracts/proposal.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readText } from '../io/read-fs.js';
import { JudgeStateError } from './errors.js';

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

export async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export function bad(why: string): never {
  throw new JudgeStateError(`JUDGE_STATE_INVALID: ${why}`);
}

export async function readRegular(file: string, what: string): Promise<string> {
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

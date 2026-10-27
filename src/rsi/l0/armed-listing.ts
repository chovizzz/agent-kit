/**
 * armed 列举(R20-1.4 / 1.5a / 1.11、R20-6.7;B4-0 冻结签名,B4a 实现;`RSI_ARMED_CLAUDE_MAX_LINES` 行 / 1 行的头部由 `parseHead` 解析):只列举和读头部(每个文件**一次**偏移 0、≤ `RSI_ARMED_HEAD_BYTES` 的物理读取),
 * 不建盐、不读正文、不写数据文件、不调 `reader.read()` / `Redactor`。头部读取至多 `RSI_ARMED_MAX_FILES` 个文件,按 mtime 降序取(D4),超出的计入 `unknownSessions`
 * 并报 `RSI_LIMIT_FILES`。盐不存在(首次 armed)时 `rows[].path` 仍给出、key 不计算(`projects.ts` 的 `key8` 为 null)。
 * `listArmed` 沿用 `projects.ts` 的 `RsiProjectsDeps.listArmed` 形状(`(io, config) => Promise<ArmedListing>`)。
 */
import * as path from 'node:path';
import {
  RSI_ARMED_CLAUDE_MAX_LINES,
  RSI_ARMED_HEAD_BYTES,
  RSI_ARMED_MAX_FILES,
  type RsiAgentId,
  type RsiCounterCode,
  type RsiState,
} from '../../contracts/rsi.js';
import { pickProcessEnv, type IoContext } from '../../io/paths.js';
import { readHeadLines } from '../../io/read-fs.js';
import { canonical } from '../../signals/exclude.js';
import type { RsiConfigOn } from '../config.js';
import { createRsiCollectPolicy } from './collect-policy.js';
import { enumerateSessionFiles } from './enumerate.js';
import { parseHead } from './head-parsers.js';
import { evaluateAgentRoot, rootIdentity } from './roots.js';
import type {
  ArmedListing,
  ArmedListingDetailed,
  Enumeration,
  L0Deps,
  SessionFile,
} from './types.js';

/** 没有命令传入的 `deps.piDirSet` 时的回退:前台看 `PI_CODING_AGENT_DIR`,worker 看 `KIT_RSI_PI_DIR_SET`(R20-2.9) */
function piDirIsSet(): boolean {
  const e = pickProcessEnv(/^(PI_CODING_AGENT_DIR|KIT_RSI_PI_DIR_SET)$/);
  return e['PI_CODING_AGENT_DIR'] !== undefined || e['KIT_RSI_PI_DIR_SET'] === '1';
}

const bytesCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function listArmedDetailed(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<ArmedListingDetailed & { complete: boolean; roots: Enumeration['roots'] }> {
  const home = io.hostEnv['HOME'] as string; // HOME 始终是 getRealHome()
  const limit = deps?.limits?.armedMaxFiles ?? RSI_ARMED_MAX_FILES;
  const piSet = deps?.piDirSet ?? piDirIsSet();
  // 根身份在列举**之前**取:列举、策略初始化、头部读取整段都绑定同一份根(之后任何一步换根都会作废该 agent 的结果)
  const idStart = new Map(
    await Promise.all(config.agents.map(async (a) => [a, await rootIdentity(home, a)] as const)),
  );
  const e = await enumerateSessionFiles(home, config, piSet, deps);
  const limitsHit = new Set<RsiCounterCode>(e.limitsHit);

  // D4:mtime 降序取前 N 个读头部,其余只计数
  const byRecent: readonly SessionFile[] = [...e.files].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || bytesCmp(a.path, b.path),
  );
  const heads = byRecent.slice(0, limit);
  let unknownSessions = byRecent.length - heads.length;
  if (unknownSessions > 0) limitsHit.add('RSI_LIMIT_FILES');

  const policy = await createRsiCollectPolicy(config, io.stateDir, deps?.probe);
  // 按 agent 分开聚合:头部读取之后发现该 agent 的根被换掉,整份作废(计入未知),不混进别的 agent 的结果
  const agentsSeen = [...new Set(heads.map((f) => f.agent))];
  const per = new Map<
    RsiAgentId,
    { roots: Map<string, { sessions: number; excluded: boolean }>; unknown: number }
  >(agentsSeen.map((a) => [a, { roots: new Map(), unknown: 0 }]));
  let filesRead = 0;
  let bytesRead = 0;
  for (const f of heads) {
    const acc = per.get(f.agent) as NonNullable<ReturnType<typeof per.get>>;
    await deps?.beforeStep?.('head', f.path);
    const maxLines = f.agent === 'claude' ? RSI_ARMED_CLAUDE_MAX_LINES : 1;
    const r = await readHeadLines(f.path, RSI_ARMED_HEAD_BYTES, maxLines, deps?.hooks);
    if (r.kind === 'missing' || r.kind === 'unsafe') {
      // 列举之后消失 / 被换成链接或 FIFO:没有读到头部,按归属不明计(不静默丢弃)
      acc.unknown++;
      continue;
    }
    filesRead++;
    bytesRead += r.bytesRead;
    const meta = parseHead(f.agent, r.lines);
    if (meta.notASession || meta.cwd === null) {
      acc.unknown++;
      continue;
    }
    const d = await policy.decide(meta.cwd);
    if (d.action === 'process') {
      const root = d.projectRoot as string;
      const row = acc.roots.get(root) ?? { sessions: 0, excluded: false };
      row.sessions++;
      acc.roots.set(root, row);
    } else if (d.reason === 'excluded') {
      const root = await canonical(meta.cwd);
      const row = acc.roots.get(root) ?? { sessions: 0, excluded: true };
      row.sessions++;
      row.excluded = true; // 同一个根上出现过排除结论,就按排除算(保守)
      acc.roots.set(root, row);
    } else if (d.reason === 'unknown_project') {
      acc.unknown++;
    }
    // self_state:反思器自己的会话,不是项目也不是未知
  }

  const byRoot = new Map<string, { sessions: number; excluded: boolean }>();
  const invalidated = new Set<RsiAgentId>();
  // 所有参与列举的 agent 都要复核(含没有候选文件、或候选被上限全部截掉的):开始时不存在的根,结束时也必须仍不存在
  for (const agent of config.agents) {
    if (e.roots[agent].status === 'not_evaluated') continue; // 列举时已不可评估(complete 已为 false)
    const acc = per.get(agent) ?? { roots: new Map(), unknown: 0 };
    const before = idStart.get(agent) ?? null;
    const after = await rootIdentity(home, agent);
    // 逐段复核根链(祖先被换成符号链接时末级 lstat 看不出来)+ 末级身份不变
    const chain = await evaluateAgentRoot(home, agent, piSet, deps);
    const changed =
      before === null
        ? after !== null
        : chain.status !== 'ok' ||
          after === null ||
          before.dev !== after.dev ||
          before.ino !== after.ino;
    if (changed) {
      invalidated.add(agent);
      unknownSessions += acc.unknown;
      for (const v of acc.roots.values()) unknownSessions += v.sessions;
      continue;
    }
    unknownSessions += acc.unknown;
    for (const [root, v] of acc.roots) {
      const row = byRoot.get(root) ?? { sessions: 0, excluded: false };
      row.sessions += v.sessions;
      row.excluded ||= v.excluded;
      byRoot.set(root, row);
    }
  }

  const rows = [...byRoot.entries()]
    .sort((a, b) => bytesCmp(a[0], b[0]))
    .map(([p, v]) => ({
      name: path.basename(p),
      sessions: v.sessions,
      path: p,
      excluded: v.excluded,
    }));
  return {
    rows,
    unknownSessions,
    filesRead,
    bytesRead,
    limitsHit: [...limitsHit].sort(),
    // 超出冻结类型的附加信息:列举不完整(根不可评估 / 读不了的目录 / 触发目录项上限 / 根被换)时 complete=false,
    // 调用方不得把这份清单当成「完整」的(例如持久化进 armed_listing 或据此显示零计数)
    complete: e.complete && invalidated.size === 0,
    roots: e.roots,
  };
}

export async function listArmed(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<ArmedListing> {
  const d = await listArmedDetailed(io, config, deps);
  return { rows: d.rows, unknownSessions: d.unknownSessions, complete: d.complete };
}

/**
 * hint 的 `armed` 模板要显示的 P / X / U(D2):读 `state.armed_listing`,只在它绑定的 `policy_fp` 与 `agents` 同当前一致时给出;
 * 缺失或不一致 → `null`(hint 输出空串,不显示过期的数字)。写入 `armed_listing` 的是 tick / confirm(B4c2),本模块只读。
 */
export function armedListingForHint(
  state: Pick<RsiState, 'armed_listing'> | null,
  policyFp: string,
  agents: readonly RsiAgentId[],
): { projects: number; excluded: number; unknown_sessions: number } | null {
  const a = state?.armed_listing;
  if (a === undefined) return null;
  const same =
    a.policy_fp === policyFp &&
    a.agents.length === agents.length &&
    [...agents].sort().every((x, i) => a.agents[i] === x);
  if (!same) return null;
  return { projects: a.projects, excluded: a.excluded, unknown_sessions: a.unknown_sessions };
}

/**
 * 钩子区的只读检视(doctor D17「钩子面」,契约 R20-17.19 / R20-17.20;A6)。纯函数 + 注入的读取器(`HooksRead` 的结构子集),**不含任何写能力**。
 *
 * 规则:
 *  - 私有状态区 `~/.local/state/agent-kit/hooks/` 不存在 → `n_a`;
 *  - 账本或标记不安全 / schema 不过 / 账本在而标记缺 / 标记在而账本缺且无 journal 兜底(R20-15.21a)→ `fail`,原因码取 `hooks_ledger_invalid` 等稳定码;
 *  - 存在残留 journal(或 tmp)→ `warn hooks_residue`:**不判漂移**、不恢复、不清理;
 *  - 否则逐 agent 比对账本登记与目标:pi 的扩展文件 sha256 与账本指纹不符、或登记的节点已不在(目标被改动)→ `warn hooks_drifted`(`SYNC_DRIFTED` 语义:只报不修);
 *  - 目标本身读取不安全(`hooks_target_unsafe`)→ 该 agent `unknown` 并 `warn hooks_target_unsafe`(A6i:契约未列此情形,按「只报不修」处理);
 *  - 其余 `ok`。
 */
import { HooksLedgerSchema, type HooksLedger } from '../../contracts/rsi-hooks.js';
import { RSI_AGENT_IDS, type RsiAgentId } from '../../contracts/rsi.js';
import { FILE_ENTRY_EVENT, entryFingerprint, sha256Hex } from './entries.js';
import { parseStrictJson } from './json-strict.js';

export type AgentHooksState = 'installed' | 'not_installed' | 'unknown';

export interface HooksFace {
  status: 'n_a' | 'ok' | 'warn' | 'fail';
  /** 该面的原因码(`ok` / `hooks_ledger_invalid` / `hooks_residue` / `hooks_drifted` ……) */
  result: string;
  agents: Readonly<Record<RsiAgentId, AgentHooksState>>;
  /** 残留 journal 与 tmp 的个数 */
  residue: number;
}

/** `HooksRead` 的结构子集(测试可注入假读取器) */
export interface HooksReader {
  stateDirExists(): Promise<boolean>;
  readLedger(): Promise<Buffer | null>;
  ledgerMarkerExists(): Promise<boolean>;
  listTxnDir(): Promise<{ journals: string[]; tmps: string[] }>;
  readTarget(agent: RsiAgentId): Promise<{ bytes: Buffer } | null>;
}

const unknownAgents = (): Record<RsiAgentId, AgentHooksState> => ({
  claude: 'unknown',
  codex: 'unknown',
  pi: 'unknown',
});
const notInstalled = (): Record<RsiAgentId, AgentHooksState> => ({
  claude: 'not_installed',
  codex: 'not_installed',
  pi: 'not_installed',
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 账本登记的某个条目在目标里是否还在(指纹一致) */
function nodePresent(
  agent: RsiAgentId,
  entry: HooksLedger['entries'][number],
  bytes: Buffer,
): boolean {
  if (agent === 'pi' || entry.event === FILE_ENTRY_EVENT)
    return sha256Hex(bytes) === entry.fingerprint;
  const p = parseStrictJson(bytes);
  if (!p.ok || !isObj(p.value)) return false;
  const hooks = p.value['hooks'];
  if (!isObj(hooks)) return false;
  const arr = hooks[entry.event];
  if (!Array.isArray(arr)) return false;
  return arr.some((el) => entryFingerprint(entry.event, el) === entry.fingerprint);
}

export async function inspectHooks(r: HooksReader): Promise<HooksFace> {
  let ledger: HooksLedger | null = null;
  let residue = 0;
  try {
    if (!(await r.stateDirExists())) {
      return { status: 'n_a', result: 'absent', agents: notInstalled(), residue: 0 };
    }
    const bytes = await r.readLedger();
    const marker = await r.ledgerMarkerExists();
    const { journals, tmps } = await r.listTxnDir();
    residue = journals.length + tmps.length;
    if (bytes !== null) {
      if (!marker) return fail('hooks_ledger_invalid');
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString('utf8'));
      } catch {
        return fail('hooks_ledger_invalid');
      }
      const p = HooksLedgerSchema.safeParse(raw);
      if (!p.success) return fail('hooks_ledger_invalid');
      ledger = p.data;
    } else if (marker && journals.length === 0) {
      return fail('hooks_ledger_invalid'); // 标记在、账本缺,且没有可兜底的 journal
    }
  } catch {
    // D17 的钩子面 fail 码只有 hooks_ledger_invalid(R20-17.19 / §19 D17 行);D17 不读备份区
    return fail('hooks_ledger_invalid');
  }

  if (residue > 0) {
    return { status: 'warn', result: 'hooks_residue', agents: unknownAgents(), residue };
  }
  const agents = notInstalled();
  let drifted = false;
  let targetUnsafe = false;
  for (const agent of RSI_AGENT_IDS) {
    const entries = (ledger?.entries ?? []).filter((e) => e.agent === agent);
    if (entries.length === 0) continue;
    try {
      const t = await r.readTarget(agent);
      if (t === null || !entries.every((e) => nodePresent(agent, e, t.bytes))) {
        drifted = true;
        agents[agent] = 'unknown';
      } else {
        agents[agent] = 'installed';
      }
    } catch {
      targetUnsafe = true;
      agents[agent] = 'unknown';
    }
  }
  // 目标不安全优先于漂移:不安全时连「漂没漂」都无法可信判定(A6i-8)
  if (targetUnsafe) return { status: 'warn', result: 'hooks_target_unsafe', agents, residue: 0 };
  if (drifted) return { status: 'warn', result: 'hooks_drifted', agents, residue: 0 };
  return { status: 'ok', result: 'ok', agents, residue: 0 };

  function fail(result: string): HooksFace {
    return { status: 'fail', result, agents: unknownAgents(), residue };
  }
}

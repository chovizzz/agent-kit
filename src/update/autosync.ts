/**
 * `update.auto_sync = "safe"` 的执行层(S7c-B;docs/contracts.md §19.6)。判定本身是 `src/sync/safe.ts` 的纯函数
 * `evaluateSafeAutoSync`;本文件负责它要求调用方做的那部分「执行不变量」:
 *
 *   先拿 sync 锁 → **锁内**重读登记表、查残留 txn、核对外部锚点、加载 payload、生成计划、逐条验证 → 写入前再取一遍磁盘快照
 *   重新生成并重新验证计划,两次必须逐项一致(目标全文与计划指纹)→ 用**同一份内存里的 LoadedPayload** 执行事务。
 *   先判断后拿锁是不允许的:任何读取登记表 / 磁盘 / payload 的动作都发生在拿到锁之后。
 *
 * 调用方(update 命令的 afterInstall 钩子)已持有 update 锁;锁序固定 update → sync,手动 `sync` 不拿 update 锁,所以不会死锁。
 * 不抛错:所有失败以 {@link LastAutoSync} 记录返回(`failed` / `declined`),由调用方在 update 锁内写进状态。
 * 永远不做首次安装(登记表不存在 → not_installed);只处理 target=home;可执行类永不自动应用(evaluator 的 executable_in_payload)。
 */
import type { SyncLedger } from '../contracts/sync.js';
import type { RenderAgentId } from '../contracts/common.js';
import type { LastAutoSync } from '../contracts/update.js';
import { OWNED_DIRS } from '../sync/classify.js';
import {
  ApplyError,
  acquireLock,
  applyPlan as applyPlanToDisk,
  freshTxnId,
  type ApplyEnv,
  type LockHandle,
} from '../sync/apply.js';
import { SyncPayloadError, loadPayload, type LoadedPayload } from '../sync/payload-load.js';
import { evaluateSafeAutoSync, type AutoSyncDeclineReason } from '../sync/safe.js';
import { planSync } from '../sync/plan.js';
import {
  buildDiskSnapshot,
  listResidualTxns,
  readLedger,
  type LedgerRead,
  type SnapshotResult,
} from '../sync/snapshot.js';
import { WRITE_OPS, type SyncPlan } from '../sync/types.js';
import { verifyInstalledTree } from './install.js';

/** 评估开关:配置 `auto_sync` 为 safe 且 `KIT_AUTO_SYNC` 不是 0(否则根本不评估、不留记录) */
export function autoSyncEnabled(
  mode: 'off' | 'safe',
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (mode !== 'safe') return false;
  const v = env?.['KIT_AUTO_SYNC']?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export interface AutoSyncInput {
  /** 刚安装成功的版本目录(绝对路径,`versions/<v>`) */
  versionRoot: string;
  version: string;
  /** 安装时记下的外部锚点(`state.installed.anchor`) */
  anchor: string;
}

export interface AutoSyncDeps {
  /** 测试注入口:在命名点执行(模拟「评估之后、写入之前」磁盘被改) */
  hook?: (point: 'before-plan' | 'after-evaluate' | 'before-apply') => void | Promise<void>;
}

const emptyCounts = { add: 0, update: 0, remove: 0 } as const;

function declined(at: Date, reason: AutoSyncDeclineReason): LastAutoSync {
  return { at: at.toISOString(), outcome: 'declined', reasons: [reason], ...emptyCounts };
}

function failed(at: Date): LastAutoSync {
  return { at: at.toISOString(), outcome: 'failed', reasons: [], ...emptyCounts };
}

interface Gathered {
  /** 本次规划用的登记表就是这次读出来的那一份(规划输入与指纹里的 sha 同源) */
  ledgerRead: Extract<LedgerRead, { state: 'ok' }>;
  snap: SnapshotResult;
  plan: SyncPlan;
}

/** 与 `agent-kit sync` 的 gather 同一套输入:登记表 + 磁盘快照 + planSync(agents 取登记表里已有的并集,不扩大) */
async function gather(
  aenv: ApplyEnv,
  payload: LoadedPayload,
  agents: readonly RenderAgentId[],
  txnId: string,
): Promise<Gathered | undefined> {
  const ledgerRead = await readLedger(aenv.homeReal);
  if (ledgerRead.state !== 'ok') return undefined;
  const ledger = ledgerRead.ledger;
  const paths = new Set<string>();
  const blockIds: Record<string, string[]> = {};
  const addBlock = (p: string, id: string | undefined): void => {
    if (id === undefined) return;
    const list = (blockIds[p] ??= []);
    if (!list.includes(id)) list.push(id);
  };
  for (const f of payload.manifest.files) {
    if (f.target !== 'home') continue;
    paths.add(f.path);
    addBlock(f.path, f.block_id);
  }
  const ledgerPaths: string[] = [];
  for (const e of ledger.entries) {
    paths.add(e.path);
    ledgerPaths.push(e.path);
    addBlock(e.path, e.block_id);
  }
  const snap = await buildDiskSnapshot({
    home: aenv.homeReal,
    paths: [...paths],
    blockIds,
    ledgerPaths,
    ownedDirs: OWNED_DIRS,
  });
  const plan = planSync({
    payload: payload.manifest,
    payloadSha256: payload.manifestSha256,
    payloadSha: payload.payloadSha,
    ledger,
    disk: snap.snapshot,
    options: { agents, overwriteDrifted: false, uninstall: false, adopt: false, txnId },
  });
  return { ledgerRead, snap, plan };
}

/** 计划指纹:写操作的 (op, path, block, 写前 / 写后 sha, agents) + 登记表动作与写前 sha + 残留 txn */
function fingerprint(g: Gathered): string {
  return JSON.stringify({
    ops: g.plan.ops.map((o) => [
      o.op,
      o.path,
      o.blockId ?? null,
      o.shaBefore ?? null,
      o.shaAfter ?? null,
      [...o.agents],
    ]),
    ledger: g.plan.ledger.action,
    ledgerSha: g.ledgerRead.state === 'ok' ? g.ledgerRead.sha256 : null,
    residual: g.snap.snapshot.residualTxn ?? null,
  });
}

/** 将被写的每个目标文件的**整文件**文本(不只是托管块):用户在块外的改动也不能被悄悄盖掉 */
function targetTexts(g: Gathered): string {
  const out: [string, string | null][] = [];
  for (const o of g.plan.ops) {
    if (!WRITE_OPS.includes(o.op)) continue;
    out.push([o.path, g.snap.texts.get(o.path) ?? null]);
  }
  return JSON.stringify(out);
}

/** 每个写操作涉及的 agent 必须已在**同一条目**(同 path + block)的 `agents` 里;条目不存在(新建)则看登记表并集 */
function perEntryAgentsOk(plan: SyncPlan, ledger: SyncLedger, known: ReadonlySet<string>): boolean {
  for (const o of plan.ops) {
    if (!WRITE_OPS.includes(o.op) && o.op !== 'adopt') continue;
    const entry = ledger.entries.find((e) => e.path === o.path && e.block_id === o.blockId);
    const allowed = entry !== undefined ? new Set<string>(entry.agents) : known;
    if (o.agents.some((a) => !allowed.has(a))) return false;
  }
  return true;
}

/**
 * 评估并(条件满足时)应用。返回要写进 `UpdateState.last_auto_sync` 的记录;`undefined` = 不评估或无事可做(不留记录)。
 */
export async function runAutoSync(
  aenv: ApplyEnv,
  input: AutoSyncInput,
  deps: AutoSyncDeps = {},
): Promise<LastAutoSync | undefined> {
  const now = (aenv.deps.now ?? ((): Date => new Date()))();
  let lock: LockHandle;
  try {
    lock = await acquireLock(aenv);
  } catch (e) {
    return e instanceof ApplyError && e.code === 'SYNC_LOCKED'
      ? declined(now, 'locked')
      : failed(now);
  }
  try {
    // ---- 以下全部在 sync 锁内 ----
    const ledgerRead = await readLedger(aenv.homeReal);
    if (ledgerRead.state === 'absent') return declined(now, 'not_installed');
    if (ledgerRead.state === 'invalid') return declined(now, 'ledger_invalid');
    if (ledgerRead.state === 'unsafe') return declined(now, 'precheck_refused');
    const ledger = ledgerRead.ledger;
    if ((await listResidualTxns(aenv.homeReal)).length > 0) return declined(now, 'txn_incomplete');

    const agents = [...new Set(ledger.entries.flatMap((e) => e.agents))].sort();
    // 空集合不得回退到默认集合(那等于扩大 agent 集合)
    if (agents.length === 0) return declined(now, 'not_installed');

    let payload: LoadedPayload;
    try {
      payload = await loadPayload(input.versionRoot);
    } catch (e) {
      if (e instanceof SyncPayloadError) return declined(now, 'integrity_unverified');
      throw e;
    }
    // 外部锚点:整树逐文件核对通过,且本次加载实际读到的 integrity.json 字节就是锚点认可的那份
    const tree = await verifyInstalledTree(input.versionRoot, {
      anchor: input.anchor,
      version: input.version,
    });
    const integrityVerified = tree.ok && payload.integritySha256 === input.anchor;

    const txnId = freshTxnId(aenv);
    await deps.hook?.('before-plan');
    const g1 = await gather(aenv, payload, agents, txnId);
    // 规划用的登记表必须就是上面做 not_installed / invalid 判断时读到的那份
    if (g1 === undefined || g1.ledgerRead.sha256 !== ledgerRead.sha256) {
      return declined(now, 'drifted');
    }
    const known = new Set<string>(agents);
    const verdict1 = evaluateSafeAutoSync(g1.plan, payload.manifest, payload.contents, {
      ledger,
      integrityVerified,
    });
    if (!verdict1.auto) return declined(now, verdict1.reason);
    if (!perEntryAgentsOk(g1.plan, ledger, known)) return declined(now, 'agent_set_expanded');
    if (!g1.plan.ops.some((o) => WRITE_OPS.includes(o.op)) && g1.plan.ledger.action === 'none') {
      return undefined; // 无事可做
    }
    await deps.hook?.('after-evaluate');

    // ---- 写入前复核:重新取快照、重新规划、重新验证;与评估时逐项一致才写 ----
    const g2 = await gather(aenv, payload, agents, txnId);
    if (g2 === undefined) return declined(now, 'ledger_invalid');
    const verdict2 = evaluateSafeAutoSync(g2.plan, payload.manifest, payload.contents, {
      ledger: g2.ledgerRead.ledger,
      integrityVerified,
    });
    if (!verdict2.auto) return declined(now, verdict2.reason);
    if (!perEntryAgentsOk(g2.plan, g2.ledgerRead.ledger, known)) {
      return declined(now, 'agent_set_expanded');
    }
    if (fingerprint(g1) !== fingerprint(g2) || targetTexts(g1) !== targetTexts(g2)) {
      return declined(now, 'drifted');
    }
    await deps.hook?.('before-apply');

    const res = await applyPlanToDisk(aenv, {
      action: 'sync',
      plan: g2.plan,
      payload,
      snapshot: g2.snap,
      ledgerRead: g2.ledgerRead,
      txnId,
      lock,
    });
    const s = g2.plan.summary;
    const base = {
      at: now.toISOString(),
      add: s.create,
      update: s.update + s.block_upsert,
      remove: s.remove + s.block_remove,
    };
    if (res.txnId === undefined) {
      // 只改了登记表(没有文件写入,没有事务):记为 applied 需要 txn_id,没有就不留记录
      return undefined;
    }
    return { ...base, outcome: 'applied', txn_id: res.txnId, reasons: [] };
  } catch {
    return failed(now);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

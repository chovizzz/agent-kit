/**
 * `rsi hooks` 事务引擎(contracts §20.15 R20-15.21–15.24a):journal → 备份 → 提交前复核 → 目标 → 账本 → 删 journal;残留恢复;restore;
 * `--discard-residue`;备份修剪。**所有写盘经 `HooksFs`**(调用方须已持有 sync 锁并把 `lock.assertHeld` 装为 `fs.setGuard`)。
 *
 * 崩溃窗口的出口(每一步之后崩溃,下一次任何 `--write` 的残留处理拿到的都是下面表里的一行;决策表 = 标记 × 账本 × journal 状态 × 目标哈希):
 *
 * | journal 状态 | 目标 | 标记 / 账本                | 处理                                                                                         |
 * | ------------ | ---- | -------------------------- | -------------------------------------------------------------------------------------------- |
 * | aborted      | 任意 | 从未建立                   | 只删 journal(不建账本)                                                                       |
 * | aborted      | 任意 | 已建立 / 账本在            | `ensureLedgerDurable` → 删 journal                                                           |
 * | aborted      | 任意 | 标记在、账本缺 + bootstrap | 提交**空账本**(只记该事务 `aborted`)→ 删 journal;无 bootstrap → `hooks_ledger_invalid`     |
 * | discarding   | 任意 | 账本已有 `discarded` 记录  | `ensureLedgerDurable` → 删 journal                                                           |
 * | discarding   | 任意 | 账本无该记录 / 缺 / 从未   | (bootstrap 时先建标记与账本)只提交 `discarded` 记录,不提交原计划归属 → 删 journal           |
 * | in_progress  | = after | 账本已记 / 未记 / 缺 / 从未 | 核对备份 = before、补设最终权限、fsync 目标目录;未记则(bootstrap 先建标记)提交原账本变更 → 删 journal |
 * | in_progress  | = before | 同上                      | 先 `writeJournal` 改记 `aborted`,再按 aborted 行处理                                         |
 * | in_progress  | 第三种值 | 任意                      | 退 4 `txn_residue_unknown`,**不建账本、不动目标**,journal 原样保留(出口只有 `--discard-residue`) |
 *
 * 持久化顺序(R20-15.21):`ledger.established` 标记在首个 `commitLedger` 的 rename **之前**独占创建并 fsync;任何 journal 删除之前先
 * `ensureLedgerDurable`(读得到不等于已持久化)。
 */
import {
  HOOKS_BACKUPS_KEPT,
  HOOKS_BACKUP_MAX_DAYS,
  HOOKS_STATE_DOC_MAX_BYTES,
  HooksJournalSchema,
  type HooksJournal,
  type HooksLedger,
  type HooksLedgerChange,
  type HooksLedgerEntry,
  type HooksPlan,
  type HooksRestorePlan,
  type HooksTxnRecord,
} from '../../contracts/rsi-hooks.js';
import { RSI_AGENT_IDS, type RsiAgentId } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { HOOKS_TARGET_RELS, HooksFsError } from '../../io/hooks-fs.js';
import { failClosed, inject, notRun, type HooksEnv } from './env.js';
import { sha256Hex } from './entries.js';
import {
  applyChange,
  compactLedger,
  emptyLedger,
  inverseOf,
  latestCommitted,
  markPruned,
  parseLedger,
  serializeLedger,
} from './ledger.js';
import { renderAfter } from './plan.js';

// ---------------------------------------------------------------------------
// 账本 / journal 读取
// ---------------------------------------------------------------------------
export type LedgerState =
  | { kind: 'ok'; ledger: HooksLedger }
  /** 标记与账本都不存在:账本从未建立(合法) */
  | { kind: 'never' }
  /** 标记在、账本缺:只有存在 `bootstraps_ledger` 的 journal 时才有合法出口(R20-15.21) */
  | { kind: 'lost' };

export async function readLedgerState(env: HooksEnv): Promise<LedgerState> {
  const bytes = await env.fs.readLedger();
  const marker = await env.fs.ledgerMarkerExists();
  if (bytes !== null) {
    // 标记总是先于账本落盘;账本在而标记缺 = 不一致,不猜
    if (!marker) throw failClosed('hooks_ledger_invalid');
    return { kind: 'ok', ledger: parseLedger(bytes) };
  }
  return marker ? { kind: 'lost' } : { kind: 'never' };
}

export async function loadJournal(env: HooksEnv, id: string): Promise<HooksJournal | null> {
  const b = await env.fs.readJournal(id);
  if (b === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(b.toString('utf8'));
  } catch {
    throw failClosed('hooks_ledger_invalid');
  }
  const p = HooksJournalSchema.safeParse(raw);
  if (!p.success) throw failClosed('hooks_ledger_invalid');
  const j = p.data;
  // journal 里的任何路径 / 标识都不作为读写依据;与文件名 / 固定 agent 不符、或字段之间自相矛盾 = 伪造(R20-15.21a)
  if (j.txn_id !== id || !journalConsistent(j)) throw failClosed('hooks_ledger_invalid');
  return j;
}

/**
 * journal 的语义一致性(评审采纳:严格 schema 只管形状,不管字段之间的关系;恢复的 `= after` 分支直接提交 `ledger_change`,
 * 不经 hooksApply 的重新生成核对,所以矛盾的记录不能让它进账本)。
 */
function journalConsistent(j: HooksJournal): boolean {
  const rec = j.ledger_change.record;
  const kindOk = j.kind === 'restore' ? j.plan.kind === 'restore' : j.plan.kind === j.kind;
  if (!kindOk || j.plan.agent !== j.agent || rec.txn_id !== j.txn_id || rec.agent !== j.agent) {
    return false;
  }
  if (j.before_exists !== (j.before_sha256 !== null)) return false;
  if (j.after_exists !== (j.after_sha256 !== null)) return false;
  if ((j.original_mode === null) === j.before_exists) return false;
  if (j.final_mode !== (j.original_mode ?? 0o600)) return false;
  if (j.plan.path !== `~/${HOOKS_TARGET_RELS[j.agent]}`) return false;
  if (rec.op !== j.kind || rec.status !== 'applied') return false;
  if (
    rec.before_exists !== j.before_exists ||
    rec.before_sha256 !== j.before_sha256 ||
    rec.after_exists !== j.after_exists ||
    rec.after_sha256 !== j.after_sha256 ||
    rec.backup !== (j.before_exists ? 'present' : 'none')
  ) {
    return false;
  }
  for (const e of [...rec.added, ...rec.removed]) if (e.agent !== j.agent) return false;
  if (j.bootstraps_ledger && j.ledger_change.expected_generation !== 0) return false;
  if (j.plan.kind === 'restore') {
    if (rec.restore_of !== j.plan.source_txn) return false;
    if (j.ledger_change.set_status?.txn_id !== j.plan.source_txn) return false;
    if (j.plan.target_exists_after !== j.before_exists) return false;
    if (j.plan.target_sha256_after !== j.before_sha256) return false;
    if (j.plan.backup_sha256 !== j.after_sha256) return false;
    return true;
  }
  if (rec.restore_of !== undefined || j.ledger_change.set_status !== undefined) return false;
  return j.plan.before_exists === j.before_exists && j.plan.before_sha256 === j.before_sha256;
}

async function journalIdSet(env: HooksEnv): Promise<Set<string>> {
  return new Set((await env.fs.listTxnDir()).journals);
}

/** 计划视图用的账本:缺失时仅当存在 bootstrap journal 才按空账本看(恢复会补建) */
export async function ledgerForPlan(env: HooksEnv): Promise<HooksLedger> {
  const st = await readLedgerState(env);
  if (st.kind === 'ok') return st.ledger;
  if (st.kind === 'never') return emptyLedger();
  for (const id of (await env.fs.listTxnDir()).journals) {
    const j = await loadJournal(env, id);
    if (j !== null && j.bootstraps_ledger) return emptyLedger();
  }
  throw failClosed('hooks_ledger_invalid');
}

// ---------------------------------------------------------------------------
// 账本提交(统一经 fs.commitLedger)
// ---------------------------------------------------------------------------
type Synth = 'change' | 'discarded' | 'aborted';

function changeOf(j: HooksJournal, mode: Synth, generationNow: number): HooksLedgerChange {
  if (mode === 'change') return j.ledger_change;
  // discarded / aborted:只记该事务,不提交原计划的归属变更;不绑定原预期代次
  return {
    expected_generation: generationNow,
    record: { ...j.ledger_change.record, status: mode, added: [], removed: [] },
  };
}

/**
 * 把 journal 对应的账本记录提交进账本(幂等:同一 `txn_id` 只生效一次)。账本从未建立 / 丢失时,只有 bootstrap journal 能走到这里:
 * 先(从未建立时)独占创建 `ledger.established` 标记并 fsync,再写账本。
 */
export async function commitJournalLedger(
  env: HooksEnv,
  j: HooksJournal,
  mode: Synth,
): Promise<void> {
  const st = await readLedgerState(env);
  let base: HooksLedger;
  let create = false;
  if (st.kind === 'ok') base = st.ledger;
  else if (j.bootstraps_ledger) {
    base = emptyLedger();
    create = st.kind === 'never';
  } else throw failClosed('hooks_ledger_invalid');
  const next = applyChange(base, changeOf(j, mode, base.generation), {
    checkGeneration: mode === 'change',
    keepTxnIds: await journalIdSet(env),
  });
  if (next === base && st.kind === 'ok') {
    // 已记录:读得到不等于已持久化——补一次 fsync 再让调用方删 journal
    await env.fs.ensureLedgerDurable();
    return;
  }
  if (create) {
    await env.fs.createLedgerMarker();
    await inject(env, 'ledger_marker_created');
  }
  await env.fs.commitLedger(serializeLedger(next));
  await inject(env, 'ledger_committed');
}

// ---------------------------------------------------------------------------
// 目标状态比较
// ---------------------------------------------------------------------------
interface TargetState {
  exists: boolean;
  sha256: string | null;
  mode: number | null;
  bytes: Buffer | null;
}

export async function targetState(env: HooksEnv, agent: RsiAgentId): Promise<TargetState> {
  const r = await env.fs.readTarget(agent);
  return r === null
    ? { exists: false, sha256: null, mode: null, bytes: null }
    : { exists: true, sha256: sha256Hex(r.bytes), mode: r.mode, bytes: r.bytes };
}

const is = (
  s: { exists: boolean; sha256: string | null },
  exists: boolean,
  sha: string | null,
): boolean => s.exists === exists && s.sha256 === sha;

// ---------------------------------------------------------------------------
// 残留处理(R20-15.22)
// ---------------------------------------------------------------------------
async function finishAborted(env: HooksEnv, j: HooksJournal): Promise<void> {
  const st = await readLedgerState(env);
  if (st.kind === 'lost') {
    if (!j.bootstraps_ledger) throw failClosed('hooks_ledger_invalid');
    // 标记在、账本缺:先补建账本(只记该事务 aborted,无任何归属),再删 journal
    await commitJournalLedger(env, j, 'aborted');
    await env.fs.ensureLedgerDurable();
  } else if (st.kind === 'ok') {
    await env.fs.ensureLedgerDurable();
  }
  // 从未建立:合法,ensureLedgerDurable 无事可做
  await env.fs.deleteJournal(j.txn_id);
  await inject(env, 'residue:journal_deleted');
}

async function finishDiscarding(env: HooksEnv, j: HooksJournal): Promise<void> {
  const st = await readLedgerState(env);
  const already =
    st.kind === 'ok' &&
    st.ledger.applied_txns.some((t) => t.txn_id === j.txn_id && t.status === 'discarded');
  if (already) await env.fs.ensureLedgerDurable();
  else await commitJournalLedger(env, j, 'discarded');
  await env.fs.ensureLedgerDurable();
  await env.fs.deleteJournal(j.txn_id);
  await inject(env, 'residue:journal_deleted');
}

async function finishApplied(env: HooksEnv, j: HooksJournal): Promise<void> {
  if (j.before_exists) {
    const b = await env.fs.readBackup(j.txn_id, j.agent);
    if (b === null || sha256Hex(b) !== j.before_sha256) throw failClosed('hooks_backup_invalid');
  }
  if (j.after_exists) await env.fs.ensureTargetMode(j.agent, j.final_mode);
  await env.fs.fsyncTargetDir(j.agent);
  await commitJournalLedger(env, j, 'change');
  await env.fs.ensureLedgerDurable();
  await env.fs.deleteJournal(j.txn_id);
  await inject(env, 'residue:journal_deleted');
}

async function processOne(env: HooksEnv, id: string): Promise<void> {
  const j = await loadJournal(env, id);
  if (j === null) return;
  // 目标 tmp 由 txn_id 推导,按名字清理(从未生效)
  await env.fs.removeTargetTmp(j.agent, id);
  await env.fs.removeBackupTmp(id, j.agent);
  if (j.state === 'aborted') return finishAborted(env, j);
  if (j.state === 'discarding') return finishDiscarding(env, j);
  const cur = await targetState(env, j.agent);
  if (is(cur, j.after_exists, j.after_sha256)) return finishApplied(env, j);
  if (is(cur, j.before_exists, j.before_sha256)) {
    const aborted: HooksJournal = { ...j, state: 'aborted' };
    await env.fs.writeJournal(id, canonicalJson(aborted));
    await inject(env, 'residue:journal_aborted');
    return finishAborted(env, aborted);
  }
  throw notRun('txn_residue_unknown');
}

/** 按 `txn_id` 升序处理全部残留 journal;`skip` 是 `--discard-residue` 所选的那一个(唯一不走通用处理的) */
export async function processResidue(env: HooksEnv, opts: { skip?: string } = {}): Promise<void> {
  const w0 = env.fs.writes;
  try {
    await env.fs.removeStrayTmps();
    const { journals } = await env.fs.listTxnDir();
    for (const id of journals) {
      if (id === opts.skip) continue;
      await processOne(env, id);
    }
  } finally {
    if (env.fs.writes > w0) env.progress.recoveryWrote = true;
  }
}

/** 是否存在任何 journal 或残留 tmp(只读;命令层用来决定「无变化的操作」是否仍需进入锁内路径) */
export async function hasResidue(env: HooksEnv): Promise<boolean> {
  return (await env.fs.listTxnDir()).journals.length > 0 || (await env.fs.hasStrayTmps());
}

// ---------------------------------------------------------------------------
// hooksApply:唯一写目标的入口(R20-15.6)
// ---------------------------------------------------------------------------
/**
 * `op` 只含 `txn_id`:路径由固定 agent 推导,写前 / 写后哈希与 ops 来自 journal(已持久化),**写后字节由本函数重新生成**
 * (install / uninstall:`renderAfter(形状, ops, 刚读到的写前字节)`;restore:内部读取受保护备份),不接收调用方给的全文。
 * 生成结果必须与 journal 记录的 `after` 存在性与哈希一致,否则内部错误(不写)。
 */
export async function hooksApply(
  env: HooksEnv,
  agent: RsiAgentId,
  op: { txn_id: string },
): Promise<void> {
  const j = await loadJournal(env, op.txn_id);
  if (j === null || j.agent !== agent || j.state !== 'in_progress') {
    throw failClosed('hooks_ledger_invalid');
  }
  const shape = env.shapes[agent];
  if (shape.target_rel !== HOOKS_TARGET_RELS[agent]) throw failClosed('internal');
  env.fs.targetRenamed = false;
  await env.fs.replaceTarget(
    agent,
    op.txn_id,
    { exists: j.before_exists, sha256: j.before_sha256 },
    j.final_mode,
    async (before) => {
      let bytes: Buffer | null;
      if (j.plan.kind === 'restore') {
        if (j.plan.backup_sha256 === null)
          bytes = null; // 写前不存在 → 受保护的删除
        else {
          const b = await env.fs.readBackup(j.plan.source_txn, agent);
          if (b === null || sha256Hex(b) !== j.plan.backup_sha256) {
            throw failClosed('hooks_backup_invalid');
          }
          bytes = b;
        }
      } else {
        const r = renderAfter(shape, j.plan.ops, before);
        if (r === null) throw failClosed('internal');
        bytes = r.bytes;
      }
      const sha = bytes === null ? null : sha256Hex(bytes);
      if ((bytes !== null) !== j.after_exists || sha !== j.after_sha256)
        throw failClosed('internal');
      await inject(env, 'target_before_write');
      return bytes;
    },
  );
}

// ---------------------------------------------------------------------------
// 事务(R20-15.21)
// ---------------------------------------------------------------------------
export function newTxnId(env: HooksEnv): string {
  const ts = env
    .now()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${ts}-${env.randomHex(8)}`;
}

export interface TxnSpec {
  agent: RsiAgentId;
  kind: 'install' | 'uninstall' | 'restore';
  plan: HooksPlan;
  before: TargetState;
  after: { exists: boolean; sha256: string | null };
  /** 由 txn_id、提交时的账本代次、当前时间生成账本变更 */
  buildChange: (txnId: string, generation: number, atIso: string) => HooksLedgerChange;
}

async function abortTxn(env: HooksEnv, j: HooksJournal): Promise<void> {
  await env.fs.writeJournal(j.txn_id, canonicalJson({ ...j, state: 'aborted' }));
  await inject(env, 'journal_aborted');
}

export async function runTxn(env: HooksEnv, spec: TxnSpec): Promise<string> {
  const st = await readLedgerState(env);
  if (st.kind === 'lost') throw failClosed('hooks_ledger_invalid');
  const generation = st.kind === 'ok' ? st.ledger.generation : 0;
  const id = newTxnId(env);
  env.progress.txnId = id;
  const at = env.now().toISOString();
  const journal: HooksJournal = {
    schema_version: 1,
    txn_id: id,
    agent: spec.agent,
    kind: spec.kind,
    state: 'in_progress',
    before_exists: spec.before.exists,
    before_sha256: spec.before.sha256,
    after_exists: spec.after.exists,
    after_sha256: spec.after.sha256,
    original_mode: spec.before.mode,
    final_mode: spec.before.mode ?? 0o600,
    plan: spec.plan,
    ledger_change: spec.buildChange(id, generation, at),
    bootstraps_ledger: st.kind === 'never',
    created_at: at,
  };
  // 写出也要守读取上限(评审采纳):journal 与提交后的账本任何一个会超读取上限,就在写任何东西之前拒绝(宁可拒绝,不写成读不回来的状态)
  const journalText = canonicalJson(journal);
  const base = st.kind === 'ok' ? st.ledger : emptyLedger();
  const keep = await journalIdSet(env);
  keep.add(id);
  const projected = applyChange(base, journal.ledger_change, {
    checkGeneration: true,
    keepTxnIds: keep,
  });
  if (
    Buffer.byteLength(journalText) > HOOKS_STATE_DOC_MAX_BYTES ||
    Buffer.byteLength(serializeLedger(projected)) > HOOKS_STATE_DOC_MAX_BYTES
  ) {
    throw failClosed('hooks_ledger_invalid');
  }
  // ① journal(创建时连同新建的各级目录一起 fsync)。rename 之后的目录 fsync 失败(含失锁)时 journal 已落盘:据此判写入承诺等级
  try {
    await env.fs.writeJournal(id, journalText);
  } catch (e) {
    try {
      if ((await env.fs.readJournal(id)) !== null) env.progress.journalWritten = true;
    } catch {
      // 读不出就按「未写」算
    }
    throw e;
  }
  env.progress.journalWritten = true;
  await inject(env, 'journal_written');
  // ② 备份并核对哈希(写前不存在 → 不建备份)
  if (spec.before.exists) {
    await env.fs.writeBackup(id, spec.agent, spec.before.bytes as Buffer);
    const back = await env.fs.readBackup(id, spec.agent);
    if (back === null || sha256Hex(back) !== spec.before.sha256) {
      throw failClosed('hooks_backup_invalid');
    }
    await inject(env, 'backup_written');
  }
  // ③④ 提交前复核 + 目标写入(hooksApply)
  try {
    await hooksApply(env, spec.agent, { txn_id: id });
  } catch (e) {
    if (env.fs.targetRenamed) env.progress.targetCommitted = true;
    if (e instanceof HooksFsError && e.code === 'target_changed') {
      await abortTxn(env, journal);
      throw notRun('config_changed_during_write');
    }
    throw e;
  }
  env.progress.targetCommitted = true;
  await inject(env, 'target_renamed');
  // ⑤ 账本(按 journal 里的变更,经 commitLedger)
  await commitJournalLedger(env, journal, 'change');
  // ⑥ 删 journal(之前先 ensureLedgerDurable)
  await env.fs.ensureLedgerDurable();
  await env.fs.deleteJournal(id);
  env.progress.complete = true;
  await inject(env, 'journal_deleted');
  return id;
}

/** 安装 / 卸载的账本变更构造 */
export function editChange(
  agent: RsiAgentId,
  kind: 'install' | 'uninstall',
  before: { exists: boolean; sha256: string | null },
  after: { exists: boolean; sha256: string | null },
  added: readonly Omit<HooksLedgerEntry, 'txn_id'>[],
  removed: readonly HooksLedgerEntry[],
): TxnSpec['buildChange'] {
  return (txnId, generation, atIso) => ({
    expected_generation: generation,
    record: {
      txn_id: txnId,
      agent,
      op: kind,
      status: 'applied',
      added: added.map((e) => ({ ...e, txn_id: txnId })),
      removed: [...removed],
      before_exists: before.exists,
      before_sha256: before.sha256,
      after_exists: after.exists,
      after_sha256: after.sha256,
      backup: before.exists ? 'present' : 'none',
      at: atIso,
    },
  });
}

// ---------------------------------------------------------------------------
// restore(R20-15.23)
// ---------------------------------------------------------------------------
export interface RestoreComputed {
  plan: HooksRestorePlan;
  source: HooksTxnRecord;
  current: TargetState;
}

/**
 * restore 计划:只能恢复该目标上**最新一个已提交(`applied`)**的事务(之后有任何事务——含 restore、`discarded`——都使它不可恢复,
 * `restore_not_latest`,零写调用);前提:当前文件哈希 = 该事务的 after(否则 `config_changed_since_install`)、备份哈希 = 该事务的 before
 * (否则 `hooks_backup_invalid`)。
 */
export async function planRestore(
  env: HooksEnv,
  agent: RsiAgentId,
  sourceTxn: string,
  pathDisplay: string,
): Promise<RestoreComputed> {
  const st = await readLedgerState(env);
  if (st.kind === 'lost') throw failClosed('hooks_ledger_invalid');
  if (st.kind === 'never') throw notRun('restore_not_latest');
  const rec = latestCommitted(st.ledger, agent);
  if (rec === undefined || rec.txn_id !== sourceTxn || rec.status !== 'applied') {
    throw notRun('restore_not_latest');
  }
  const cur = await targetState(env, agent);
  if (!is(cur, rec.after_exists, rec.after_sha256)) throw notRun('config_changed_since_install');
  if (rec.before_exists) {
    if (rec.backup === 'pruned') throw failClosed('hooks_backup_invalid');
    const b = await env.fs.readBackup(sourceTxn, agent);
    if (b === null || sha256Hex(b) !== rec.before_sha256) throw failClosed('hooks_backup_invalid');
  }
  return {
    plan: {
      kind: 'restore',
      agent,
      path: pathDisplay,
      source_txn: sourceTxn,
      ledger_generation: st.ledger.generation,
      target_exists_after: rec.after_exists,
      target_sha256_after: rec.after_sha256,
      backup_sha256: rec.before_exists ? rec.before_sha256 : null,
    },
    source: rec,
    current: cur,
  };
}

/** restore 作为事务执行(自己的 journal、备份、`generation` 加 1);源事务记 `restored`,账本做逆变更 */
export async function runRestore(env: HooksEnv, rc: RestoreComputed): Promise<string> {
  const src = rc.source;
  const spec: TxnSpec = {
    agent: src.agent,
    kind: 'restore',
    plan: rc.plan,
    before: rc.current,
    after: { exists: src.before_exists, sha256: src.before_sha256 },
    buildChange: (txnId, generation, atIso) => {
      const inv = inverseOf(src, txnId);
      return {
        expected_generation: generation,
        record: {
          txn_id: txnId,
          agent: src.agent,
          op: 'restore',
          status: 'applied',
          restore_of: src.txn_id,
          added: inv.added,
          removed: inv.removed,
          before_exists: rc.current.exists,
          before_sha256: rc.current.sha256,
          after_exists: src.before_exists,
          after_sha256: src.before_sha256,
          backup: rc.current.exists ? 'present' : 'none',
          at: atIso,
        },
        set_status: { txn_id: src.txn_id, status: 'restored' },
      };
    },
  };
  return runTxn(env, spec);
}

// ---------------------------------------------------------------------------
// --discard-residue(R20-15.22)
// ---------------------------------------------------------------------------
export interface DiscardComputed {
  journal: HooksJournal;
  /** 当前目标哈希(展示用;确认后与锁内重读比较) */
  current: TargetState;
}

/** 只读:所选 journal 必须存在、属于该 agent,且(进行中)目标是第三种值,或已是 `discarding`(续做) */
export async function planDiscard(
  env: HooksEnv,
  agent: RsiAgentId,
  txnId: string,
): Promise<DiscardComputed> {
  const j = await loadJournal(env, txnId);
  if (j === null || j.agent !== agent) throw notRun('txn_residue_unknown');
  const cur = await targetState(env, agent);
  if (j.state === 'discarding') return { journal: j, current: cur };
  // 契约只授权「第三种值」从这里退出;其它状态不强行记 discarded(评审采纳,缺口列为待定夺)
  if (
    j.state !== 'in_progress' ||
    is(cur, j.after_exists, j.after_sha256) ||
    is(cur, j.before_exists, j.before_sha256)
  ) {
    throw notRun('txn_residue_unknown');
  }
  return { journal: j, current: cur };
}

/**
 * 顺序:journal 改记 `discarding` 并 fsync → 经 `commitLedger` 把该事务记 `discarded`、`generation` 加 1(不写目标文件,未提交的归属变更不生效)→
 * 删 journal 并 fsync。`discarding` 已持久化之后的任何失败 = `maintenance=partial`(下一次任何 `--write` 按残留处理的 `discarding` 行补完)。
 */
export async function runDiscard(env: HooksEnv, dc: DiscardComputed): Promise<void> {
  const partial = (): void => {
    env.progress.maintenance = 'partial';
    env.progress.maintenanceKind = 'discard';
  };
  let j = dc.journal;
  if (j.state !== 'discarding') {
    j = { ...j, state: 'discarding' };
    try {
      await env.fs.writeJournal(j.txn_id, canonicalJson(j));
    } catch (e) {
      // rename 已完成而目录 fsync 失败 / 失锁:`discarding` 已可见,按实际阶段记 partial
      try {
        if ((await loadJournal(env, j.txn_id))?.state === 'discarding') partial();
      } catch {
        // 读不出就按「未开始」算
      }
      throw e;
    }
  }
  partial();
  await inject(env, 'discard:journal_discarding');
  await finishDiscarding(env, j);
  env.progress.maintenance = 'done';
}

// ---------------------------------------------------------------------------
// 备份修剪(R20-15.24)
// ---------------------------------------------------------------------------
function idTime(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id);
  if (m === null) return 0;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/**
 * 待修剪的备份 `txn_id`(升序)。**受保护备份**(每个目标上最新一个已提交事务)与有在途 journal 引用的备份不修剪、也不计入上限;
 * 其余最多保留 10 份(按 `txn_id` 新→旧)且不超过 30 个 UTC 日,超出即修剪。
 */
export async function planPrune(env: HooksEnv): Promise<string[]> {
  // 账本「丢失」但有 bootstrap journal 时按空账本看(随后的残留处理会补建);否则 hooks_ledger_invalid
  const ledger = await ledgerForPlan(env);
  const dirs = await env.fs.listBackupIds();
  const inFlight = await journalIdSet(env);
  const protectedIds = new Set<string>();
  for (const a of RSI_AGENT_IDS) {
    const r = latestCommitted(ledger, a);
    if (r !== undefined) protectedIds.add(r.txn_id);
  }
  const cands = dirs
    .filter((d) => !protectedIds.has(d) && !inFlight.has(d))
    .sort()
    .reverse();
  const nowMs = env.now().getTime();
  const maxAgeMs = HOOKS_BACKUP_MAX_DAYS * 86_400_000;
  return cands
    .filter((id, idx) => idx >= HOOKS_BACKUPS_KEPT || nowMs - idTime(id) > maxAgeMs)
    .sort();
}

/**
 * 顺序:先经 `commitLedger` 把对应事务记 `backup_pruned` → 再删备份目录并 fsync `backups/`。中途崩溃留下「账本已记 pruned、目录还在」时,
 * 下一次修剪从目录列表重新选中它并直接删目录(无害方向)。修剪只改这些事务的 `backup` 标记,不改归属与其它记录,不动 `generation`。
 */
export async function execPrune(env: HooksEnv, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const partial = (): void => {
    env.progress.maintenance = 'partial';
    env.progress.maintenanceKind = 'prune';
  };
  const st = await readLedgerState(env);
  if (st.kind === 'lost') throw failClosed('hooks_ledger_invalid');
  if (st.kind === 'ok') {
    const marked = markPruned(st.ledger, new Set(ids));
    const next = compactLedger(marked, await journalIdSet(env));
    if (next !== st.ledger) {
      try {
        await env.fs.commitLedger(serializeLedger(next));
      } catch (e) {
        // rename 已完成而目录 fsync 失败 / 失锁:`backup_pruned` 已可见,按实际阶段记 partial
        try {
          const now = await readLedgerState(env);
          if (now.kind === 'ok' && serializeLedger(now.ledger) === serializeLedger(next)) partial(); // 磁盘上已是提交后的账本
        } catch {
          // 读不出就按「未开始」算
        }
        throw e;
      }
      partial(); // `backup_pruned` 已提交:此后失败 = 部分完成
      await inject(env, 'prune:ledger_committed');
    }
  }
  for (const id of ids) {
    await env.fs.deleteBackupDir(id, partial); // 删到一半失败(目录 fsync / 失锁)也已是部分完成
    partial();
    await inject(env, 'prune:dir_deleted');
  }
  env.progress.maintenance = 'done';
  env.progress.maintenanceKind = 'prune';
}

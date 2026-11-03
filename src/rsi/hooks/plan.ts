/**
 * 计划:纯函数,由「形状表 + 读到的目标字节 + 账本归属」生成同一份计划(干跑与 `--write` 共用,R20-15.18),并能由「计划 + 写前字节」重新生成写后字节
 * (`renderAfter`,hooksApply 用它——原语不收调用方给的全文,R20-15.6)。契约 §20.15 R20-15.10–15.13、15.15–15.17、15.27。
 *
 * 归属规则(R20-15.11–15.13):
 *  - 安装时每个所需条目 = 一个**独立新增**的包装对象,追加到 `hooks[event]` 数组末尾;永不并入用户已有的包装对象(卸载因此只删最小节点);
 *  - 「所需条目已存在」(包装对象与形状逐字段一致)= 安装幂等、不写;账本无归属记录时它不可由 kit 卸载;
 *  - 命令前缀是 `agent-kit rsi` 的钩子,必须恰好出现在某个形状表条目的**完整包装**里,否则 `foreign_kit_entry`(同命令不同包装、用户加了字段、命令不在形状表);
 *  - 同一形状出现多处无法唯一定位 → `ambiguous_entry`;
 *  - 账本登记且指纹一致的另一变体(hint ↔ canary)→ 同一事务 remove + add;未登记的互斥变体 → `conflicting_shape_unowned`;
 *  - 卸载只删账本登记过、且指纹仍一致的最小节点;节点被改过 → `config_changed_since_install`;节点已不在 → 不操作。
 */
import {
  HOOKS_KIT_COMMAND_PREFIX,
  HOOKS_TARGET_MAX_BYTES,
  sourceOf,
  type FileShape,
  type HookShape,
  type HookVariant,
  type HooksEditPlan,
  type HooksLedgerEntry,
  type HooksPlanOp,
  type JsonMergeShape,
  type RsiHooksNotRunReason,
} from '../../contracts/rsi-hooks.js';
import {
  FILE_ENTRY_EVENT,
  allFileSources,
  allJsonSpecs,
  entryFingerprint,
  sha256Hex,
  variantJsonSpecs,
  type JsonObject,
  type JsonSpecView,
} from './entries.js';
import { canonicalFormat, parseStrictJson, serializeJson } from './json-strict.js';

export interface AfterState {
  exists: boolean;
  bytes: Buffer | null;
  sha256: string | null;
}

export interface PlanReject {
  ok: false;
  reason: RsiHooksNotRunReason;
}

export interface Computed {
  ok: true;
  plan: HooksEditPlan;
  after: AfterState;
  /** 本事务新增的归属(缺 `txn_id`,提交时补) */
  added: Omit<HooksLedgerEntry, 'txn_id'>[];
  /** 本事务移出账本的归属(含「节点已不在」的陈旧归属) */
  removed: HooksLedgerEntry[];
}

export interface PlanInput {
  kind: 'install' | 'uninstall';
  shape: HookShape;
  variant: HookVariant;
  /** 目标原字节;不存在 → null */
  before: Buffer | null;
  /** 账本里该 agent 的归属 */
  owned: readonly HooksLedgerEntry[];
  /** `~/` 相对写法(R20-15.25) */
  pathDisplay: string;
  /** claude 的 settings.local.json 只读检查结果(R20-15.27;仅安装用) */
  local: 'none' | 'found' | 'failed';
}

const reject = (reason: RsiHooksNotRunReason): PlanReject => ({ ok: false, reason });

const isObj = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 包装对象:键 ⊆ {matcher, hooks},`hooks` 是数组,`matcher` 缺省或字符串 */
export function isWrapper(v: unknown): v is JsonObject & { hooks: unknown[] } {
  if (!isObj(v)) return false;
  for (const k of Object.keys(v)) if (k !== 'matcher' && k !== 'hooks') return false;
  if (!Array.isArray(v['hooks'])) return false;
  return v['matcher'] === undefined || typeof v['matcher'] === 'string';
}

function hasKitCommand(w: unknown): boolean {
  if (!isObj(w) || !Array.isArray(w['hooks'])) return false;
  return w['hooks'].some(
    (h) =>
      isObj(h) &&
      typeof h['command'] === 'string' &&
      h['command'].startsWith(HOOKS_KIT_COMMAND_PREFIX),
  );
}

interface Present {
  event: string;
  index: number;
  fingerprint: string;
}

/** 扫描整个 `hooks` 对象里所有带 kit 命令前缀的包装对象 */
function scanKit(hooks: JsonObject): Present[] {
  const out: Present[] = [];
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    arr.forEach((el, index) => {
      if (isObj(el) && hasKitCommand(el)) {
        out.push({ event, index, fingerprint: entryFingerprint(event, el) });
      }
    });
  }
  return out;
}

type ParsedTarget = { ok: true; doc: JsonObject; trailingNewline: boolean } | PlanReject;

/** R20-15.15 / 15.16:解析、形状、格式保真闸(文件不存在 → 空形态) */
export function parseTarget(shape: JsonMergeShape, before: Buffer | null): ParsedTarget {
  if (before === null) {
    return {
      ok: true,
      doc: JSON.parse(JSON.stringify(shape.empty_root)) as JsonObject,
      trailingNewline: true,
    };
  }
  const p = parseStrictJson(before);
  if (!p.ok) return reject('config_unparsable');
  if (!isObj(p.value)) return reject('config_shape_unsupported');
  const doc = p.value;
  const hooks = doc['hooks'];
  if (hooks !== undefined) {
    if (!isObj(hooks)) return reject('config_shape_unsupported');
    const targetEvents = new Set(allJsonSpecs(shape).map((s) => s.event));
    for (const ev of targetEvents) {
      const arr = hooks[ev];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) return reject('config_shape_unsupported');
      if (!arr.every((el) => isWrapper(el))) return reject('config_shape_unsupported');
    }
  }
  const c = canonicalFormat(p.text, p.value);
  if (!c.ok) return reject('config_not_canonical');
  return { ok: true, doc, trailingNewline: c.trailingNewline };
}

function sortOps(ops: HooksPlanOp[]): HooksPlanOp[] {
  const rank = { remove: 0, add: 1 } as const;
  return [...ops].sort(
    (a, b) =>
      rank[a.op] - rank[b.op] ||
      (a.event < b.event ? -1 : a.event > b.event ? 1 : 0) ||
      (a.entry_fingerprint < b.entry_fingerprint
        ? -1
        : a.entry_fingerprint > b.entry_fingerprint
          ? 1
          : 0),
  );
}

function mkPlan(i: PlanInput, ops: HooksPlanOp[]): HooksEditPlan {
  return {
    kind: i.kind,
    agent: i.shape.agent,
    path: i.pathDisplay,
    before_exists: i.before !== null,
    before_sha256: i.before === null ? null : sha256Hex(i.before),
    ops: sortOps(ops),
    shape_version: i.shape.shape_version,
    variant: i.variant,
  };
}

// ---------------------------------------------------------------------------
// 应用 ops(plan 与 renderAfter 共用)
// ---------------------------------------------------------------------------
function applyJsonOps(
  doc: JsonObject,
  shape: JsonMergeShape,
  ops: readonly HooksPlanOp[],
): boolean {
  const specs = allJsonSpecs(shape);
  for (const op of ops) {
    if (op.op === 'remove') {
      const hooks = doc['hooks'];
      if (!isObj(hooks)) return false;
      const arr = hooks[op.event];
      if (!Array.isArray(arr)) return false;
      const idx = arr
        .map((el, k) =>
          isObj(el) && entryFingerprint(op.event, el) === op.entry_fingerprint ? k : -1,
        )
        .filter((k) => k >= 0);
      if (idx.length !== 1) return false;
      arr.splice(idx[0] as number, 1);
    } else {
      const spec = specs.find(
        (s) => s.event === op.event && s.fingerprint === op.entry_fingerprint,
      );
      if (spec === undefined) return false;
      if (doc['hooks'] === undefined) doc['hooks'] = {};
      const hooks = doc['hooks'];
      if (!isObj(hooks)) return false;
      if (hooks[op.event] === undefined) hooks[op.event] = [];
      const arr = hooks[op.event];
      if (!Array.isArray(arr)) return false;
      arr.push(JSON.parse(JSON.stringify(spec.wrapper)) as JsonObject);
    }
  }
  return true;
}

function applyFileOps(shape: FileShape, ops: readonly HooksPlanOp[]): AfterState | null {
  const adds = ops.filter((o) => o.op === 'add');
  if (adds.length === 0) return { exists: false, bytes: null, sha256: null };
  if (adds.length !== 1) return null;
  const src = allFileSources(shape).find(
    (s) => s.fingerprint === (adds[0] as HooksPlanOp).entry_fingerprint,
  );
  if (src === undefined) return null;
  const bytes = Buffer.from(src.source, 'utf8');
  return { exists: true, bytes, sha256: sha256Hex(bytes) };
}

/**
 * 由计划里的 ops 与写前字节重新生成写后字节(hooksApply 用;调用方不能给全文)。解析 / 形状失败或 ops 对不上 → `null`。
 * 与 `computePlan` 用同一份 `parseTarget` 与 `applyJsonOps`,所以对同一份写前字节结果相同。
 */
export function renderAfter(
  shape: HookShape,
  ops: readonly HooksPlanOp[],
  before: Buffer | null,
): AfterState | null {
  if (shape.kind === 'file') return applyFileOps(shape, ops);
  const parsed = parseTarget(shape, before);
  if (!parsed.ok) return null;
  if (!applyJsonOps(parsed.doc, shape, ops)) return null;
  const bytes = serializeJson(parsed.doc, parsed.trailingNewline);
  return { exists: true, bytes, sha256: sha256Hex(bytes) };
}

// ---------------------------------------------------------------------------
// json-merge 计划
// ---------------------------------------------------------------------------
function ledgerAdd(
  s: JsonSpecView,
  shape: HookShape,
  variant: HookVariant,
): Omit<HooksLedgerEntry, 'txn_id'> {
  return {
    agent: shape.agent,
    event: s.event,
    fingerprint: s.fingerprint,
    shape_version: shape.shape_version,
    variant,
  };
}

function planJson(i: PlanInput, shape: JsonMergeShape): Computed | PlanReject {
  const parsed = parseTarget(shape, i.before);
  if (!parsed.ok) return parsed;
  const doc = parsed.doc;
  const hooksObj = isObj(doc['hooks']) ? doc['hooks'] : {};
  const specs = allJsonSpecs(shape);
  const knownFps = new Set(specs.map((s) => s.fingerprint));
  const present = scanKit(hooksObj);
  const count = new Map<string, Present[]>();
  for (const p of present) count.set(p.fingerprint, [...(count.get(p.fingerprint) ?? []), p]);
  const ownedByFp = new Map(i.owned.map((e) => [e.fingerprint, e]));

  const ops: HooksPlanOp[] = [];
  const added: Omit<HooksLedgerEntry, 'txn_id'>[] = [];
  const removed: HooksLedgerEntry[] = [];

  if (i.kind === 'install') {
    const desired = variantJsonSpecs(shape, i.variant);
    if (desired === null) throw new Error('shape has no such variant');
    for (const p of present) if (!knownFps.has(p.fingerprint)) return reject('foreign_kit_entry');
    for (const d of desired)
      if ((count.get(d.fingerprint)?.length ?? 0) > 1) return reject('ambiguous_entry');
    const desiredFps = new Set(desired.map((d) => d.fingerprint));
    for (const [fp, ps] of count) {
      if (desiredFps.has(fp)) continue;
      if (ps.length > 1) return reject('ambiguous_entry');
      const own = ownedByFp.get(fp);
      if (own === undefined) return reject('conflicting_shape_unowned');
      ops.push({ op: 'remove', event: (ps[0] as Present).event, entry_fingerprint: fp });
      removed.push(own);
    }
    if (i.local === 'found') return reject('duplicate_in_local');
    if (i.local === 'failed') return reject('duplicate_check_failed');
    for (const d of desired) {
      if ((count.get(d.fingerprint)?.length ?? 0) === 0) {
        ops.push({ op: 'add', event: d.event, entry_fingerprint: d.fingerprint });
        added.push(ledgerAdd(d, shape, i.variant));
      }
    }
  } else {
    const stale: HooksLedgerEntry[] = [];
    for (const o of i.owned) {
      const ps = count.get(o.fingerprint) ?? [];
      if (ps.length > 1) return reject('ambiguous_entry');
      if (ps.length === 1) {
        ops.push({ op: 'remove', event: o.event, entry_fingerprint: o.fingerprint });
        removed.push(o);
        continue;
      }
      // 节点不在:同事件里若有「带 kit 前缀、不在形状表、也不归属于别的账本条目」的包装对象,视为被改过
      const modified = present.some(
        (p) => p.event === o.event && !knownFps.has(p.fingerprint) && !ownedByFp.has(p.fingerprint),
      );
      if (modified) return reject('config_changed_since_install');
      stale.push(o);
    }
    if (ops.length > 0) removed.push(...stale);
  }

  const plan = mkPlan(i, ops);
  if (ops.length === 0) {
    return {
      ok: true,
      plan,
      after: {
        exists: i.before !== null,
        bytes: i.before,
        sha256: i.before === null ? null : sha256Hex(i.before),
      },
      added: [],
      removed: [],
    };
  }
  if (!applyJsonOps(doc, shape, plan.ops)) return reject('ambiguous_entry');
  const bytes = serializeJson(doc, parsed.trailingNewline);
  // 写出也要守读取上限(评审采纳):写后超过 1 MiB 的文件下一次读取就是 hooks_target_unsafe,事务会卡在待恢复
  if (bytes.length > HOOKS_TARGET_MAX_BYTES) return reject('config_shape_unsupported');
  return {
    ok: true,
    plan,
    after: { exists: true, bytes, sha256: sha256Hex(bytes) },
    added,
    removed,
  };
}

// ---------------------------------------------------------------------------
// pi(整文件)计划
// ---------------------------------------------------------------------------
function planFile(i: PlanInput, shape: FileShape): Computed | PlanReject {
  const unchanged = (): Computed => ({
    ok: true,
    plan: mkPlan(i, []),
    after: {
      exists: i.before !== null,
      bytes: i.before,
      sha256: i.before === null ? null : sha256Hex(i.before),
    },
    added: [],
    removed: [],
  });
  const own = i.owned.find((e) => e.event === FILE_ENTRY_EVENT);
  const beforeSha = i.before === null ? null : sha256Hex(i.before);

  if (i.kind === 'uninstall') {
    if (own === undefined || i.before === null) return unchanged();
    if (beforeSha !== own.fingerprint) return reject('config_changed_since_install');
    return {
      ok: true,
      plan: mkPlan(i, [
        { op: 'remove', event: FILE_ENTRY_EVENT, entry_fingerprint: own.fingerprint },
      ]),
      after: { exists: false, bytes: null, sha256: null },
      added: [],
      removed: [own],
    };
  }

  const source = sourceOf(shape, i.variant);
  if (source === null) throw new Error('shape has no such variant');
  const bytes = Buffer.from(source, 'utf8');
  const fp = sha256Hex(bytes);
  const entry: Omit<HooksLedgerEntry, 'txn_id'> = {
    agent: shape.agent,
    event: FILE_ENTRY_EVENT,
    fingerprint: fp,
    shape_version: shape.shape_version,
    variant: i.variant,
  };
  if (i.before === null) {
    return {
      ok: true,
      plan: mkPlan(i, [{ op: 'add', event: FILE_ENTRY_EVENT, entry_fingerprint: fp }]),
      after: { exists: true, bytes, sha256: fp },
      added: [entry],
      removed: [],
    };
  }
  if (beforeSha === fp) return unchanged(); // 内容已是所需形状:安装幂等
  if (own === undefined) return reject('foreign_kit_entry'); // 同名文件存在而账本无归属:不覆盖
  if (beforeSha !== own.fingerprint) return reject('config_changed_since_install'); // 有记录但内容漂移
  // 账本登记且内容未漂移的另一形状 / 变体:同一事务 remove + add
  return {
    ok: true,
    plan: mkPlan(i, [
      { op: 'remove', event: FILE_ENTRY_EVENT, entry_fingerprint: own.fingerprint },
      { op: 'add', event: FILE_ENTRY_EVENT, entry_fingerprint: fp },
    ]),
    after: { exists: true, bytes, sha256: fp },
    added: [entry],
    removed: [own],
  };
}

/** 生成计划。`ok:false` = 稳定拒绝原因(`RSI_HOOKS_NOT_RUN reason=`);无变化的操作 `plan.ops` 为空 */
export function computePlan(i: PlanInput): Computed | PlanReject {
  return i.shape.kind === 'json-merge' ? planJson(i, i.shape) : planFile(i, i.shape);
}

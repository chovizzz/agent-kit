import { RENDER_AGENT_IDS, type RenderAgentId } from '../contracts/common.js';
import { PayloadManifestSchema, type PayloadFile } from '../contracts/payload.js';
import {
  HOME_WRITE_TABLE,
  SyncLedgerSchema,
  isHomeWritePath,
  type SyncLedger,
  type SyncLedgerEntry,
} from '../contracts/sync.js';
import {
  CODE,
  OWNED_DIRS,
  decideDesired,
  decideRemoval,
  preflightEntry,
  targetKey,
  type DesiredTarget,
} from './classify.js';
import {
  WRITE_OPS,
  type DiskEntry,
  type PlanInput,
  type PlanOp,
  type PlanOpBase,
  type PlanSummary,
  type SyncPlan,
} from './types.js';

/**
 * S3:sync 计划器(纯函数,契约 §19.2,设计稿 §1.2 / §1.3)。
 * 输入 = payload × 登记表 × 磁盘快照 × 选项;输出 = 有序操作列表 + 新登记表 + 汇总 + 退出码建议。
 * 不读盘、不写盘、不联网、不读时钟。
 *
 * 优先级:预检类拒绝(残留事务 / 路径越界 / 登记表或 payload 非法 / 共享路径冲突 / 中间段或本体是链接 /
 * 硬链接 / 非常规文件 / 托管块损坏)优先于一切;只要有一条命中,整次 `refuse-all`,不产生任何写操作。
 */

const LEDGER_FILE = '.local/state/agent-kit/sync/ledger.json';
const PAYLOAD_FILE = '.local/share/agent-kit/payload/manifest.json';
const TXN_DIR = '.local/state/agent-kit/sync/txn/';

const AGENT_ORDER = new Map<string, number>(RENDER_AGENT_IDS.map((a, i) => [a, i]));
const sortAgents = (agents: Iterable<RenderAgentId>): RenderAgentId[] =>
  [...new Set(agents)].sort((a, b) => (AGENT_ORDER.get(a) ?? 0) - (AGENT_ORDER.get(b) ?? 0));

const missing: DiskEntry = { kind: 'missing' };

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const rawOf = (v: unknown): Record<string, unknown> => (isRec(v) ? v : {});

function emptySummary(): PlanSummary {
  return {
    create: 0,
    update: 0,
    remove: 0,
    block_upsert: 0,
    block_remove: 0,
    adopt: 0,
    skip_drifted: 0,
    orphan_keep: 0,
    unmanaged_keep: 0,
    refuse_foreign: 0,
    refuse_all: 0,
  };
}

function finish(
  status: SyncPlan['status'],
  rawOps: PlanOp[],
  ledger: SyncPlan['ledger'],
  skippedLayers: readonly string[],
): SyncPlan {
  const ops = [...rawOps].sort((a, b) => {
    const ka = targetKey(a.path, a.blockId);
    const kb = targetKey(b.path, b.blockId);
    return ka < kb ? -1 : ka > kb ? 1 : a.op < b.op ? -1 : a.op > b.op ? 1 : 0;
  });
  const summary = emptySummary();
  const codes = new Set<string>();
  for (const o of ops) {
    if (o.code !== undefined) codes.add(o.code);
    if (o.op.startsWith('refuse_') && o.op !== 'refuse_foreign') summary.refuse_all += 1;
    else if (o.op in summary) summary[o.op as keyof PlanSummary] += 1;
  }
  const hasWrite = ops.some((o) => WRITE_OPS.includes(o.op));
  let exit: SyncPlan['exit'];
  if (status === 'refuse-all') exit = 3;
  else if (status === 'not-run') exit = 4;
  else {
    exit =
      summary.skip_drifted + summary.orphan_keep + summary.unmanaged_keep + summary.refuse_foreign >
      0
        ? 1
        : 0;
  }
  return {
    status,
    ops,
    ledger,
    summary,
    exit,
    codes: [...codes].sort(),
    empty: !hasWrite && ledger.action === 'none' && ops.length === 0,
    skippedLayers,
  };
}

const NO_LEDGER_CHANGE = { action: 'none', next: null } as const;

function refusal(
  op: PlanOpBase['op'],
  code: string,
  path: string,
  extra: Partial<PlanOpBase> = {},
): PlanOp {
  return { op, code, path, agents: [], ...extra };
}

function sameEntry(a: SyncLedgerEntry, b: SyncLedgerEntry): boolean {
  return (
    a.path === b.path &&
    a.kind === b.kind &&
    a.sha256 === b.sha256 &&
    a.block_id === b.block_id &&
    a.created_file === b.created_file &&
    a.agents.length === b.agents.length &&
    a.agents.every((x, i) => x === b.agents[i]) &&
    a.txn === b.txn
  );
}

export function planSync(input: PlanInput): SyncPlan {
  const { options, disk } = input;
  if (options.uninstall && options.adopt) {
    throw new TypeError('uninstall 与 adopt 互斥(命令层应已按 mode_conflict 拒绝)');
  }
  const selected = new Set<RenderAgentId>(options.agents);
  const skippedLayers = arr(rawOf(input.payload)['skippedLayers']).flatMap((s) =>
    isRec(s) && typeof s['layer'] === 'string' ? [s['layer']] : [],
  );
  const refusals: PlanOp[] = [];
  const refuse = (op: PlanOp): void => {
    refusals.push(op);
  };

  // ---- 阶段 A:全局与文档级预检 ----
  if (disk.residualTxn !== undefined && disk.residualTxn !== null) {
    refuse(refusal('refuse_residual_txn', CODE.TXN_INCOMPLETE, TXN_DIR));
  }

  // 路径越界:先看原始路径(契约 schema 会先一步把它们挡成 PAYLOAD/LEDGER_INVALID,这里要给出更准确的 WRITE_DENIED)
  // (原始扫描对畸形文档也不抛异常:结构问题留给下面的 schema 校验归类)
  // 卸载不需要 payload:payload 的任何问题都不阻断卸载
  const homeFiles = (
    options.uninstall
      ? []
      : arr(rawOf(input.payload)['files']).filter(
          (f): f is PayloadFile =>
            isRec(f) &&
            f['target'] === 'home' &&
            typeof f['path'] === 'string' &&
            typeof f['agent'] === 'string' &&
            selected.has(f['agent'] as RenderAgentId),
        )
  ) as PayloadFile[];
  let payloadDenied = false;
  for (const f of homeFiles) {
    if (!isHomeWritePath(f.path, 'adapter')) {
      payloadDenied = true;
      refuse(refusal('refuse_denied', CODE.WRITE_DENIED, f.path, { agents: [f.agent] }));
    }
  }
  let ledgerDenied = false;
  for (const e of arr(rawOf(input.ledger)['entries'])) {
    if (isRec(e) && typeof e['path'] === 'string' && !isHomeWritePath(e['path'], 'adapter')) {
      ledgerDenied = true;
      refuse(
        refusal('refuse_denied', CODE.WRITE_DENIED, e['path'], {
          agents: arr(e['agents']).filter((a): a is RenderAgentId => typeof a === 'string'),
        }),
      );
    }
  }

  if (input.ledger !== null && !ledgerDenied && !SyncLedgerSchema.safeParse(input.ledger).success) {
    refuse(refusal('refuse_invalid', CODE.LEDGER_INVALID, LEDGER_FILE));
  }
  if (input.payload !== null && !options.uninstall && !payloadDenied) {
    if (!PayloadManifestSchema.safeParse(input.payload).success) {
      refuse(refusal('refuse_invalid', CODE.PAYLOAD_INVALID, PAYLOAD_FILE));
    } else {
      for (const f of homeFiles) {
        if (input.payloadSha[f.payload_path] !== f.sha256) {
          refuse(
            refusal('refuse_invalid', CODE.PAYLOAD_INVALID, f.path, {
              ...(f.block_id !== undefined ? { blockId: f.block_id } : {}),
              agents: [f.agent],
            }),
          );
        }
      }
    }
  }
  if (refusals.length > 0) {
    return finish('refuse-all', refusals, NO_LEDGER_CHANGE, skippedLayers);
  }

  if (input.payload === null && !options.uninstall) {
    return finish(
      'not-run',
      [refusal('refuse_invalid', CODE.NO_PAYLOAD, PAYLOAD_FILE)],
      NO_LEDGER_CHANGE,
      skippedLayers,
    );
  }

  // ---- 阶段 B:期望目标(payload × agent 集合),共享路径去重与冲突 ----
  const ledgerEntries = input.ledger?.entries ?? [];
  const ledgerByKey = new Map<string, SyncLedgerEntry>();
  const ledgerKindByPath = new Map<string, Set<string>>();
  for (const e of ledgerEntries) {
    ledgerByKey.set(targetKey(e.path, e.block_id), e);
    const kinds = ledgerKindByPath.get(e.path) ?? new Set<string>();
    kinds.add(e.kind);
    ledgerKindByPath.set(e.path, kinds);
  }
  // 同一路径同时登记 owned 与 block:宿主文件的所有权自相矛盾(卸载会生成互相打架的操作),与模式无关,一律拒绝
  for (const [path, kinds] of ledgerKindByPath) {
    if (kinds.size > 1) refuse(refusal('refuse_invalid', CODE.LEDGER_INVALID, path));
  }
  if (refusals.length > 0) {
    return finish('refuse-all', refusals, NO_LEDGER_CHANGE, skippedLayers);
  }

  const desired = new Map<string, DesiredTarget>();
  if (!options.uninstall) {
    const allHome = (input.payload?.files ?? []).filter((f) => f.target === 'home');
    // 路径 -> 参与比较的 payload 文件(选中的 agent + 登记表里仍请求该路径、但不在本次集合内的 agent)
    const byPath = new Map<string, PayloadFile[]>();
    for (const f of allHome) {
      const L = ledgerByKey.get(targetKey(f.path, f.block_id));
      const outsideRequester = L !== undefined && L.agents.includes(f.agent);
      if (!selected.has(f.agent) && !outsideRequester) continue;
      const list = byPath.get(f.path) ?? [];
      list.push(f);
      byPath.set(f.path, list);
    }
    for (const [path, files] of [...byPath].sort(([a], [b]) => (a < b ? -1 : 1))) {
      // 只检查本次有选中请求者的路径:集合之外的登记请求者只在它们碰巧共用这个路径时参与比较
      if (!files.some((f) => selected.has(f.agent))) continue;
      // owned 与 block 混用同一路径,或同一目标 sha 不同 → 整次拒绝
      const modes = new Set(files.map((f) => f.mode));
      const perKey = new Map<string, PayloadFile[]>();
      for (const f of files) {
        const k = targetKey(f.path, f.block_id);
        perKey.set(k, [...(perKey.get(k) ?? []), f]);
      }
      const conflictAgents = new Set<RenderAgentId>();
      if (modes.size > 1) for (const f of files) conflictAgents.add(f.agent);
      for (const group of perKey.values()) {
        if (new Set(group.map((f) => f.sha256)).size > 1) {
          for (const f of group) conflictAgents.add(f.agent);
        }
      }
      if (conflictAgents.size > 0) {
        refuse(
          refusal('refuse_shared_conflict', CODE.SHARED_PATH_CONFLICT, path, {
            agents: sortAgents(conflictAgents),
          }),
        );
        continue;
      }
      // 登记表里该路径的种类与 payload 要的不一致(owned 文件被当成托管块宿主,或反过来)
      const wantKind = files.some((f) => f.mode === 'managed-block') ? 'block' : 'owned';
      const haveKinds = ledgerKindByPath.get(path);
      if (haveKinds !== undefined && [...haveKinds].some((k) => k !== wantKind)) {
        refuse(refusal('refuse_invalid', CODE.LEDGER_INVALID, path));
        continue;
      }
      for (const group of perKey.values()) {
        const first = group[0] as PayloadFile;
        const sel = group.filter((f) => selected.has(f.agent)).map((f) => f.agent);
        if (sel.length === 0) continue;
        desired.set(targetKey(first.path, first.block_id), {
          path: first.path,
          mode: first.mode === 'managed-block' ? 'block' : 'owned',
          ...(first.block_id !== undefined ? { blockId: first.block_id } : {}),
          sha: first.sha256,
          agents: sortAgents(sel),
        });
      }
    }
  }

  // 本次要动的登记条目:请求者里有选中 agent、且不再被期望的
  const ledgerOnly = ledgerEntries.filter(
    (e) => !desired.has(targetKey(e.path, e.block_id)) && e.agents.some((a) => selected.has(a)),
  );
  // 它们当中「去掉选中 agent 后无人请求」的才真的碰磁盘
  const removalCandidates = ledgerOnly.filter((e) => e.agents.every((a) => selected.has(a)));

  // ---- 阶段 C:磁盘预检(链接 / 硬链接 / 非常规文件 / 托管块损坏) ----
  const diskOf = (path: string): DiskEntry => disk.entries[path] ?? missing;
  const touched: { path: string; blockId?: string; agents: readonly RenderAgentId[] }[] = [
    ...[...desired.values()].map((t) => ({
      path: t.path,
      ...(t.blockId !== undefined ? { blockId: t.blockId } : {}),
      agents: t.agents,
    })),
    ...(options.adopt
      ? []
      : removalCandidates.map((e) => ({
          path: e.path,
          ...(e.block_id !== undefined ? { blockId: e.block_id } : {}),
          agents: sortAgents(e.agents),
        }))),
  ];
  const seenPre = new Set<string>();
  for (const t of touched) {
    const hit = preflightEntry(diskOf(t.path), t.blockId);
    if (hit === null) continue;
    const k = `${targetKey(t.path, t.blockId)}|${hit.code}`;
    if (seenPre.has(k)) continue;
    seenPre.add(k);
    refuse(
      refusal(hit.op, hit.code, t.path, {
        ...(t.blockId !== undefined ? { blockId: t.blockId } : {}),
        agents: t.agents,
      }),
    );
  }
  if (refusals.length > 0) {
    return finish('refuse-all', refusals, NO_LEDGER_CHANGE, skippedLayers);
  }

  // ---- 阶段 D:逐目标分类 ----
  const ops: PlanOp[] = [];
  const next = new Map<string, SyncLedgerEntry>();
  const keep = (e: SyncLedgerEntry): void => {
    next.set(targetKey(e.path, e.block_id), e);
  };

  for (const t of desired.values()) {
    const key = targetKey(t.path, t.blockId);
    const L = ledgerByKey.get(key);
    const d = diskOf(t.path);
    const known = [...new Set([t.sha, ...(input.knownSha?.[key] ?? [])])];
    const dec = decideDesired(t, L, d, {
      overwriteDrifted: options.overwriteDrifted,
      adopt: options.adopt,
      known,
    });
    const base = {
      path: t.path,
      ...(t.blockId !== undefined ? { blockId: t.blockId } : {}),
      agents: t.agents,
    };
    const mkEntry = (over: Partial<SyncLedgerEntry>): SyncLedgerEntry => ({
      path: t.path,
      kind: t.mode,
      sha256: t.sha,
      ...(t.blockId !== undefined ? { block_id: t.blockId } : {}),
      created_file: false,
      agents: t.agents as RenderAgentId[],
      txn: options.txnId,
      ...over,
    });
    switch (dec.act) {
      case 'noop': {
        if (L === undefined) break;
        const agents = sortAgents([...L.agents.filter((a) => !selected.has(a)), ...t.agents]);
        const sha = dec.ledgerSha ?? L.sha256;
        if (options.adopt) {
          keep(L);
        } else if (sha === L.sha256 && agents.join() === L.agents.join()) keep(L);
        else keep({ ...L, sha256: sha, agents, txn: options.txnId });
        break;
      }
      case 'write': {
        const agents = sortAgents([
          ...(L?.agents.filter((a) => !selected.has(a)) ?? []),
          ...t.agents,
        ]);
        ops.push({
          ...base,
          op: dec.op,
          shaBefore: dec.shaBefore,
          shaAfter: t.sha,
          createdFile: dec.createdFile,
          ...(dec.overwroteDrifted ? { overwroteDrifted: true } : {}),
        });
        keep(mkEntry({ created_file: dec.createdFile, agents }));
        break;
      }
      case 'skip_drifted':
        ops.push({ ...base, op: 'skip_drifted', code: CODE.DRIFTED });
        if (L !== undefined) keep(L);
        break;
      case 'foreign':
        ops.push({ ...base, op: 'refuse_foreign', code: CODE.TARGET_FOREIGN });
        break;
      case 'adopt':
        ops.push({ ...base, op: 'adopt' });
        keep(mkEntry({ created_file: false, sha256: dec.sha }));
        break;
      default:
        break; // drop / remove / orphan_keep 不会出现在期望目标上
    }
  }

  const ledgerOnlyKeys = new Set(ledgerOnly.map((e) => targetKey(e.path, e.block_id)));
  for (const e of ledgerEntries) {
    const key = targetKey(e.path, e.block_id);
    if (desired.has(key)) continue;
    if (!ledgerOnlyKeys.has(key) || options.adopt) {
      keep(e); // 与选中 agent 无关 / adopt 不动已有登记
      continue;
    }
    const remaining = e.agents.filter((a) => !selected.has(a));
    if (remaining.length > 0) {
      keep({ ...e, agents: sortAgents(remaining), txn: options.txnId });
      continue;
    }
    const base = {
      path: e.path,
      ...(e.block_id !== undefined ? { blockId: e.block_id } : {}),
      agents: sortAgents(e.agents),
    };
    const dec = decideRemoval(e, diskOf(e.path));
    if (dec.act === 'remove') {
      ops.push({
        ...base,
        op: dec.op,
        shaBefore: dec.shaBefore,
        shaAfter: null,
        ...(dec.deleteFileIfBlank ? { deleteFileIfBlank: true } : {}),
      });
    } else if (dec.act === 'orphan_keep') {
      // 卸载时叫漂移跳过,payload 里没了时叫孤儿保留;稳定码同为 SYNC_DRIFTED,条目留在登记表里
      ops.push({
        ...base,
        op: options.uninstall ? 'skip_drifted' : 'orphan_keep',
        code: CODE.DRIFTED,
      });
      keep(e);
    }
    // drop:磁盘上已经没有了,登记条目随之丢弃
  }

  // ---- 独占目录里的非登记文件 ----
  for (const dir of OWNED_DIRS) {
    const listing = disk.ownedDirListings?.[dir];
    if (listing === undefined) continue;
    const relevant = HOME_WRITE_TABLE.some(
      (t) => t.path === dir && t.agents.some((a) => selected.has(a)),
    );
    if (!relevant) continue;
    const ours = new Set<string>([
      ...ledgerEntries.map((e) => e.path),
      ...[...desired.values()].map((t) => t.path),
    ]);
    for (const p of [...listing].sort()) {
      if (!p.startsWith(dir) || ours.has(p)) continue;
      if (
        p
          .slice(dir.length)
          .split('/')
          .some((seg) => seg.startsWith('.'))
      )
        continue;
      ops.push({ op: 'unmanaged_keep', code: CODE.UNMANAGED_IN_OWNED_DIR, path: p, agents: [] });
    }
  }

  // ---- 登记表 ----
  const findings = ops.some(
    (o) =>
      o.code !== undefined &&
      (o.op === 'skip_drifted' ||
        o.op === 'orphan_keep' ||
        o.op === 'unmanaged_keep' ||
        o.op === 'refuse_foreign'),
  );
  const nextEntries = [...next.values()].sort((a, b) => {
    const ka = targetKey(a.path, a.block_id);
    const kb = targetKey(b.path, b.block_id);
    return ka < kb ? -1 : 1;
  });
  const old = input.ledger;
  let header: Pick<SyncLedger, 'kit_version' | 'payload_sha256'>;
  if (old !== null) {
    header =
      options.uninstall || findings || input.payload === null
        ? { kit_version: old.kit_version, payload_sha256: old.payload_sha256 }
        : { kit_version: input.payload.kit_version, payload_sha256: input.payloadSha256 };
  } else if (input.payload !== null) {
    header = { kit_version: input.payload.kit_version, payload_sha256: input.payloadSha256 };
  } else {
    return finish('ok', ops, NO_LEDGER_CHANGE, skippedLayers);
  }
  const nextLedger: SyncLedger = { schema_version: 1, ...header, entries: nextEntries };

  let ledger: SyncPlan['ledger'];
  if (old === null) {
    ledger = nextEntries.length === 0 ? NO_LEDGER_CHANGE : { action: 'write', next: nextLedger };
  } else if (options.uninstall && nextEntries.length === 0) {
    ledger = { action: 'delete', next: null };
  } else {
    const same =
      old.kit_version === nextLedger.kit_version &&
      old.payload_sha256 === nextLedger.payload_sha256 &&
      old.entries.length === nextEntries.length &&
      old.entries.every((e, i) => sameEntry(e, nextEntries[i] as SyncLedgerEntry));
    ledger = same ? NO_LEDGER_CHANGE : { action: 'write', next: nextLedger };
  }
  return finish('ok', ops, ledger, skippedLayers);
}

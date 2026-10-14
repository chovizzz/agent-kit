import type { RenderAgentId } from '../../src/contracts/common.js';
import type { PayloadManifest } from '../../src/contracts/payload.js';
import type { SyncLedger, SyncLedgerEntry } from '../../src/contracts/sync.js';
import { planSync } from '../../src/sync/plan.js';
import type {
  BlockSnapshot,
  DiskEntry,
  DiskSnapshot,
  PlanInput,
  PlanOptions,
  SyncPlan,
} from '../../src/sync/types.js';

export const h = (c: string): string => c.repeat(64).slice(0, 64);
export const TXN = 'txn-20261014T120000Z-a1b2c3';
export const TXN2 = 'txn-20261015T120000Z-d4e5f6';
export const DEFAULT_AGENTS: RenderAgentId[] = ['claude', 'codex', 'pi'];

export interface FileSpec {
  agent: RenderAgentId;
  path: string;
  sha: string;
  block?: string;
}

export function payloadOf(specs: FileSpec[]): {
  manifest: PayloadManifest;
  sha: Record<string, string>;
} {
  const files = specs
    .map((s) => ({
      agent: s.agent,
      target: 'home' as const,
      path: s.path,
      mode: s.block === undefined ? ('owned' as const) : ('managed-block' as const),
      ...(s.block !== undefined ? { block_id: s.block } : {}),
      kind: s.block === undefined ? ('skill' as const) : ('rules' as const),
      confidence: 'documented' as const,
      sha256: s.sha,
      bytes: 10,
      payload_path: `files/${s.agent}/home/${s.path}`,
      atoms: [],
    }))
    .sort((a, b) => {
      const ka = `${a.agent}/${a.target}/${a.path}`;
      const kb = `${b.agent}/${b.target}/${b.path}`;
      return ka < kb ? -1 : 1;
    });
  const sha: Record<string, string> = {};
  for (const f of files) sha[f.payload_path] = f.sha256;
  return {
    manifest: {
      schema_version: 1,
      kit_version: '0.2.0',
      channel: 'stable',
      files,
      migrations: [],
      skippedLayers: [{ layer: 'personal', reason: 'v1' }],
    } as PayloadManifest,
    sha,
  };
}

export const P = {
  claudeSkill: '.claude/skills/commit-checklist/SKILL.md',
  sharedSkill: '.agents/skills/commit-checklist/SKILL.md',
  rules: '.claude/rules/agent-kit/org.md',
  codexMd: '.codex/AGENTS.md',
  piMd: '.pi/agent/AGENTS.md',
  kimiMd: '.kimi-code/AGENTS.md',
  rulesDir: '.claude/rules/agent-kit/',
} as const;
export const BLOCK = 'agent-kit-rules';

/** 基准 payload:claude 技能 + claude 规则 + codex/pi 共用技能 + codex/pi 托管块(各自一个文件) */
export function basePayload(
  over: Partial<
    Record<'claudeSkill' | 'sharedSkill' | 'rules' | 'codexBlock' | 'piBlock', string>
  > = {},
) {
  const s = {
    claudeSkill: h('a'),
    sharedSkill: h('b'),
    rules: h('c'),
    codexBlock: h('d'),
    piBlock: h('e'),
    ...over,
  };
  return {
    shas: s,
    ...payloadOf([
      { agent: 'claude', path: P.claudeSkill, sha: s.claudeSkill },
      { agent: 'claude', path: P.rules, sha: s.rules },
      { agent: 'codex', path: P.sharedSkill, sha: s.sharedSkill },
      { agent: 'codex', path: P.codexMd, sha: s.codexBlock, block: BLOCK },
      { agent: 'pi', path: P.sharedSkill, sha: s.sharedSkill },
      { agent: 'pi', path: P.piMd, sha: s.piBlock, block: BLOCK },
    ]),
  };
}

export function ledgerOf(entries: SyncLedgerEntry[], over: Partial<SyncLedger> = {}): SyncLedger {
  const sorted = [...entries].sort((a, b) => {
    const ka = `${a.path}\u0000${a.block_id ?? ''}`;
    const kb = `${b.path}\u0000${b.block_id ?? ''}`;
    return ka < kb ? -1 : 1;
  });
  return {
    schema_version: 1,
    kit_version: '0.2.0',
    payload_sha256: h('9'),
    entries: sorted,
    ...over,
  };
}

export function entry(
  path: string,
  sha: string,
  agents: RenderAgentId[],
  o: { block?: string; created?: boolean; txn?: string } = {},
): SyncLedgerEntry {
  return {
    path,
    kind: o.block === undefined ? 'owned' : 'block',
    sha256: sha,
    ...(o.block !== undefined ? { block_id: o.block } : {}),
    created_file: o.created ?? o.block === undefined,
    agents,
    txn: o.txn ?? TXN,
  };
}

export const file = (sha: string, extra: Partial<DiskEntry> = {}): DiskEntry => ({
  kind: 'file',
  sha256: sha,
  ...extra,
});
export const blockFile = (
  bodySha: string | null,
  o: { state?: BlockSnapshot['state']; restBlank?: boolean; fileSha?: string } = {},
): DiskEntry => ({
  kind: 'file',
  sha256: o.fileSha ?? h('7'),
  blocks:
    bodySha === null && o.state === undefined
      ? {}
      : {
          [BLOCK]: {
            state: o.state ?? 'intact',
            ...(bodySha !== null ? { bodySha } : {}),
            restBlank: o.restBlank ?? false,
          },
        },
});

export function snap(
  entries: Record<string, DiskEntry>,
  extra: Partial<DiskSnapshot> = {},
): DiskSnapshot {
  return { entries, ...extra };
}

/** 与 basePayload 完全一致的已安装磁盘 + 登记表 */
export function installed(over: Parameters<typeof basePayload>[0] = {}) {
  const b = basePayload(over);
  const s = b.shas;
  const ledger = ledgerOf([
    entry(P.claudeSkill, s.claudeSkill, ['claude']),
    entry(P.rules, s.rules, ['claude']),
    entry(P.sharedSkill, s.sharedSkill, ['codex', 'pi']),
    entry(P.codexMd, s.codexBlock, ['codex'], { block: BLOCK, created: true }),
    entry(P.piMd, s.piBlock, ['pi'], { block: BLOCK, created: false }),
  ]);
  const disk = snap(
    {
      [P.claudeSkill]: file(s.claudeSkill),
      [P.rules]: file(s.rules),
      [P.sharedSkill]: file(s.sharedSkill),
      [P.codexMd]: blockFile(s.codexBlock),
      [P.piMd]: blockFile(s.piBlock),
    },
    { ownedDirListings: { [P.rulesDir]: [P.rules] } },
  );
  return { ...b, ledger, disk };
}

export function opts(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    agents: DEFAULT_AGENTS,
    overwriteDrifted: false,
    uninstall: false,
    adopt: false,
    txnId: TXN2,
    ...over,
  };
}

export function input(
  b: { manifest: PayloadManifest | null; sha: Record<string, string> },
  ledger: SyncLedger | null,
  disk: DiskSnapshot,
  o: Partial<PlanOptions> = {},
  extra: Partial<PlanInput> = {},
): PlanInput {
  return {
    payload: b.manifest,
    payloadSha256: h('9'),
    payloadSha: b.sha,
    ledger,
    disk,
    options: opts(o),
    ...extra,
  };
}

export const plan = (i: PlanInput): SyncPlan => planSync(i);

/** `op@path` 或 `op@path#block`,便于断言 */
export const brief = (p: SyncPlan): string[] =>
  p.ops.map((o) => `${o.op}@${o.path}${o.blockId !== undefined ? `#${o.blockId}` : ''}`);

/** 把计划应用到快照上(只模拟 sha 层面),用来验证幂等:应用后再规划必须为空。 */
export function applyPlan(
  disk: DiskSnapshot,
  p: SyncPlan,
  ledger: SyncLedger | null,
): { disk: DiskSnapshot; ledger: SyncLedger | null } {
  const entries: Record<string, DiskEntry> = { ...disk.entries };
  for (const o of p.ops) {
    if (o.op === 'create' || o.op === 'update') {
      entries[o.path] = file(o.shaAfter as string);
    } else if (o.op === 'remove') {
      delete entries[o.path];
    } else if (o.op === 'block_upsert') {
      const prev = entries[o.path];
      entries[o.path] = {
        kind: 'file',
        sha256: h('6'),
        blocks: {
          ...(prev?.blocks ?? {}),
          [o.blockId as string]: {
            state: 'intact',
            bodySha: o.shaAfter as string,
            restBlank: false,
          },
        },
      };
    } else if (o.op === 'block_remove') {
      if (o.deleteFileIfBlank === true) delete entries[o.path];
      else {
        const prev = entries[o.path] as DiskEntry;
        const blocks = { ...(prev.blocks ?? {}) };
        delete blocks[o.blockId as string];
        entries[o.path] = { ...prev, blocks };
      }
    }
  }
  const next =
    p.ledger.action === 'write' ? p.ledger.next : p.ledger.action === 'delete' ? null : ledger;
  return { disk: { ...disk, entries }, ledger: next };
}

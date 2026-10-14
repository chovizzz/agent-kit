/**
 * S5:doctor 的只读探测层。把磁盘 / 环境 / 包内 payload 读成 checks.ts 要的输入。
 * 只用 read-fs(只读 API)与 `src/sync/{snapshot,payload-load}.ts`(同样只读);不 import 任何写出口、网络模块、子进程。
 * 读到的文件内容只用来算 sha / 解析结构,不会流入输出。
 */
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadKitConfig, loadOverlayFile } from '../build/config.js';
import { PayloadIntegritySchema } from '../contracts/payload.js';
import type { PayloadFile, PayloadManifest } from '../contracts/payload.js';
import { JUDGE_HOP_CHAIN } from '../contracts/proposal.js';
import { DEFAULT_SYNC_AGENTS } from '../contracts/sync.js';
import type { RenderAgentId } from '../contracts/common.js';
import type { SyncLedger } from '../contracts/sync.js';
import { UPDATE_PIN_RE, UserConfigSchema } from '../contracts/update.js';
import type { UpdateState } from '../contracts/update.js';
import { lstat, readBytes, readDir, realpath, stat } from '../io/read-fs.js';
import { applyManagedBlock, parseManagedBlocks } from '../render/managed-block.js';
import { defaultRegistry } from '../render/registry.js';
import { OWNED_DIRS } from '../sync/classify.js';
import {
  SyncPayloadError,
  loadPayload,
  packageRoot,
  resolvePayloadRoot,
} from '../sync/payload-load.js';
import type { LoadedPayload } from '../sync/payload-load.js';
import { planSync } from '../sync/plan.js';
import {
  MAX_READ_BYTES,
  buildDiskSnapshot,
  listResidualTxns,
  probePath,
  readLedger,
  sha256Of,
  type LedgerRead,
  type SnapshotResult,
} from '../sync/snapshot.js';
import type { DiskEntry, SyncPlan } from '../sync/types.js';
import { autoUpdateGate } from '../update/policy.js';
import { parseUpdateState } from '../update/state.js';
import type {
  D01Input,
  D02Input,
  D03Input,
  D04Input,
  D05Entry,
  D06Target,
  D09Input,
  D10Input,
  D10Target,
  D11Input,
  D12Input,
  D14Input,
  D15Input,
} from './checks.js';

export const STATE_DIR_REL = '.local/state/agent-kit';
export const SHARE_DIR_REL = '.local/share/agent-kit';
export const CODEX_MD = '.codex/AGENTS.md';
export const PI_MD = '.pi/agent/AGENTS.md';
const NO_TXN = 'txn-00000000T000000Z-000000';

type Env = Readonly<Record<string, string | undefined>>;

export interface CollectDeps {
  /** 测试注入:各 adapter 的 tested_versions 个数;缺省取默认注册表 */
  testedVersions?: () => Promise<Record<string, number>>;
  now?: () => Date;
  /** 测试注入:覆盖 process.versions.node */
  nodeVersion?: string;
}

export interface CollectArgs {
  home: string;
  env: Env;
  tmpDir: string | undefined;
  repoRoot: string;
  stateDir: string;
  overlayPath: string | undefined;
  deps: CollectDeps;
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

const join = (home: string, rel: string): string => path.join(home, ...rel.split('/'));

/** 所有读取共用的失败收敛:读不了 = 不可读,不向上抛异常消息。 */
async function safely<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

export class Collector {
  private memo = new Map<string, Promise<unknown>>();
  constructor(private readonly a: CollectArgs) {}

  private once<T>(key: string, f: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (p === undefined) {
      p = f();
      this.memo.set(key, p);
    }
    return p;
  }

  // ---- 状态目录(D14 与 fail-closed) ----

  stateDir(): Promise<D14Input> {
    return this.once('stateDir', async () => {
      let cur = this.a.home;
      let st: Awaited<ReturnType<typeof lstat>> | null = null;
      for (const seg of STATE_DIR_REL.split('/')) {
        cur = path.join(cur, seg);
        st = await lstatOrNull(cur);
        if (st === null) return { dir: 'absent', mode: undefined, ownedByCurrentUser: undefined };
        if (st.isSymbolicLink() || !st.isDirectory()) {
          return { dir: 'unsafe', mode: undefined, ownedByCurrentUser: undefined };
        }
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      return {
        dir: 'ok',
        mode: (st as NonNullable<typeof st>).mode & 0o777,
        ownedByCurrentUser:
          uid === undefined ? undefined : (st as NonNullable<typeof st>).uid === uid,
      };
    });
  }

  async stateUnsafe(): Promise<boolean> {
    return (await this.stateDir()).dir === 'unsafe';
  }

  // ---- 登记表 ----

  ledgerRead(): Promise<LedgerRead> {
    return this.once('ledger', async () => {
      if (await this.stateUnsafe()) return { state: 'unsafe' };
      return readLedger(this.a.home);
    });
  }

  async ledger(): Promise<SyncLedger | null> {
    const r = await this.ledgerRead();
    return r.state === 'ok' ? r.ledger : null;
  }

  residualTxns(): Promise<string[]> {
    return this.once('txns', async () =>
      (await this.stateUnsafe()) ? [] : safely(() => listResidualTxns(this.a.home), []),
    );
  }

  async d04(): Promise<D04Input> {
    const r = await this.ledgerRead();
    return {
      ledger: r.state === 'ok' ? 'ok' : r.state === 'invalid' ? 'invalid' : 'absent',
      entries: r.state === 'ok' ? r.ledger.entries.length : 0,
      kitVersion: r.state === 'ok' ? r.ledger.kit_version : undefined,
      residualTxns: await this.residualTxns(),
    };
  }

  // ---- UpdateState / 配置 ----

  /** absent = 没有 state.json;unreadable = 存在但读不了 / 不合 schema(→ doctor fail-closed) */
  updateState(): Promise<{ s: 'absent' } | { s: 'unreadable' } | { s: 'ok'; state: UpdateState }> {
    return this.once('updateState', async () => {
      if (await this.stateUnsafe()) return { s: 'absent' as const };
      let probe;
      try {
        probe = await probePath(this.a.home, `${STATE_DIR_REL}/update/state.json`);
      } catch {
        return { s: 'unreadable' as const };
      }
      if (probe.entry.kind === 'missing') return { s: 'absent' as const };
      if (probe.entry.kind !== 'file' || probe.text === undefined)
        return { s: 'unreadable' as const };
      const parsed = parseUpdateState(probe.text);
      return parsed.ok ? { s: 'ok' as const, state: parsed.state } : { s: 'unreadable' as const };
    });
  }

  async state(): Promise<UpdateState | undefined> {
    const r = await this.updateState();
    return r.s === 'ok' ? r.state : undefined;
  }

  private config(): Promise<D12Input['config']> {
    return this.once('config', async () => {
      const dflt = { autoInstall: true, autoSync: 'safe', pin: undefined, registry: '' };
      let probe;
      try {
        probe = await probePath(this.a.home, '.config/agent-kit/config.toml');
      } catch {
        return { status: 'invalid' as const, ...dflt };
      }
      if (probe.entry.kind === 'missing') return { status: 'absent' as const, ...dflt };
      if (probe.entry.kind !== 'file' || probe.text === undefined) {
        return { status: 'invalid' as const, ...dflt };
      }
      try {
        const cfg = UserConfigSchema.parse(parseToml(probe.text)).update;
        return {
          status: 'ok' as const,
          autoInstall: cfg.auto_install,
          autoSync: cfg.auto_sync,
          pin: cfg.pin,
          registry: cfg.registry,
        };
      } catch {
        return { status: 'invalid' as const, ...dflt };
      }
    });
  }

  async d12(online: boolean): Promise<D12Input> {
    const cfg = await this.config();
    const env = this.a.env;
    const registry = cfg.registry === '' ? 'https://registry.npmjs.org/' : cfg.registry;
    const envPinRaw = env['KIT_UPDATE_PIN'];
    const envPin =
      envPinRaw === undefined || envPinRaw === ''
        ? undefined
        : UPDATE_PIN_RE.test(envPinRaw)
          ? envPinRaw
          : 'invalid';
    const unsafe = await this.stateUnsafe();
    const updDir = `${STATE_DIR_REL}/update`;
    const lock = unsafe
      ? null
      : await safely(() => lstatOrNull(join(this.a.home, `${updDir}/lock`)), null);
    return {
      online,
      state: await this.state(),
      config: { ...cfg, registry },
      gate: autoUpdateGate({ env, isTTY: true, autoInstall: cfg.autoInstall, command: 'doctor' }),
      envPin,
      autoSyncEnvOff: ['0', 'false', 'off', 'no'].includes(
        (env['KIT_AUTO_SYNC'] ?? '').trim().toLowerCase(),
      ),
      lockPresent: lock !== null,
      stagingCount: await this.stagingCount(),
      ownVersion: await this.ownVersion(),
    };
  }

  private stagingCount(): Promise<number> {
    return this.once('staging', () =>
      safely(async () => {
        let cur = this.a.home;
        for (const seg of `${SHARE_DIR_REL}/staging`.split('/')) {
          cur = path.join(cur, seg);
          const st = await lstatOrNull(cur);
          if (st === null || st.isSymbolicLink() || !st.isDirectory()) return 0;
        }
        return (await readDir(cur)).length;
      }, 0),
    );
  }

  // ---- D01 / D02 ----

  ownVersion(): Promise<string | undefined> {
    return this.once('ownVersion', () =>
      safely(async () => {
        const root = packageRoot();
        if (root === undefined) return undefined;
        const bytes = await readBytes(path.join(root, 'package.json'));
        const v = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { version?: unknown })
          .version;
        return typeof v === 'string' ? v : undefined;
      }, undefined),
    );
  }

  async d01(): Promise<D01Input> {
    const st = await this.state();
    const link = await safely(
      () => lstatOrNull(join(this.a.home, `${SHARE_DIR_REL}/current`)),
      null,
    );
    const launched = this.a.env['KIT_LAUNCHED'];
    return {
      nodeVersion: this.a.deps.nodeVersion ?? process.versions.node,
      bootstrapVersion: await this.ownVersion(),
      currentLink: link === null ? 'absent' : link.isSymbolicLink() ? 'symlink' : 'other',
      installedVersion: st?.installed?.version,
      launched: launched !== undefined && launched !== '' && launched !== '0',
    };
  }

  async d02(): Promise<D02Input> {
    const empty = { checked: 0, mismatch: 0, missing: 0, extra: 0 };
    const share = join(this.a.home, SHARE_DIR_REL);
    const cur = join(this.a.home, `${SHARE_DIR_REL}/current`);
    const lst = await safely(() => lstatOrNull(cur), null);
    const st = await this.state();
    const base: D02Input = {
      current: 'present',
      integrity: 'missing',
      files: empty,
      integritySha256: undefined,
      anchor: st?.installed?.anchor,
    };
    if (lst === null) return { ...base, current: 'absent' };
    const unsafe = { ...base, current: 'unsafe' as const };
    if (!lst.isSymbolicLink()) return unsafe;
    let root: string;
    try {
      root = await realpath(cur);
      const versions = await realpath(path.join(share, 'versions'));
      const rel = path.relative(versions, root);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return unsafe;
      if (!(await stat(root)).isDirectory()) return unsafe;
    } catch {
      return unsafe;
    }
    const regular = async (abs: string): Promise<Uint8Array | undefined> => {
      const s = await lstatOrNull(abs);
      if (s === null || !s.isFile() || s.isSymbolicLink() || s.size > MAX_READ_BYTES)
        return undefined;
      return readBytes(abs);
    };
    const ibytes = await safely(() => regular(path.join(root, 'integrity.json')), undefined);
    if (ibytes === undefined) return base;
    const integritySha256 = sha256Of(ibytes);
    let files: { path: string; sha256: string; bytes: number }[];
    try {
      files = PayloadIntegritySchema.parse(JSON.parse(Buffer.from(ibytes).toString('utf8'))).files;
    } catch {
      return { ...base, integrity: 'invalid', integritySha256 };
    }
    let mismatch = 0;
    let missing = 0;
    for (const f of files) {
      const b = await safely(() => regular(path.join(root, ...f.path.split('/'))), undefined);
      if (b === undefined) missing += 1;
      else if (sha256Of(b) !== f.sha256 || b.byteLength !== f.bytes) mismatch += 1;
    }
    const listed = new Set(files.map((f) => f.path));
    let extra = 0;
    let budget = 20000;
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 16 || budget <= 0) return;
      const entries = await safely(
        () => readDir(rel === '' ? root : path.join(root, ...rel.split('/'))),
        [],
      );
      for (const e of entries) {
        budget -= 1;
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory && !e.isSymbolicLink) await walk(r, depth + 1);
        else if (!listed.has(r) && r !== 'integrity.json') extra += 1;
      }
    };
    await walk('', 0);
    return {
      ...base,
      integrity: 'ok',
      integritySha256,
      files: { checked: files.length, mismatch, missing, extra },
    };
  }

  // ---- payload ----

  payload(): Promise<{ p: LoadedPayload } | { p: null; reason: string }> {
    return this.once('payload', async () => {
      try {
        const root = await resolvePayloadRoot(this.a.env, this.a.tmpDir);
        return { p: await loadPayload(root) };
      } catch (e) {
        return {
          p: null,
          reason: e instanceof SyncPayloadError ? e.detail : 'unreadable',
        } as const;
      }
    });
  }

  async d03(): Promise<D03Input> {
    const r = await this.payload();
    if (r.p === null) {
      return {
        state: r.reason === 'absent' || r.reason === 'no_package_root' ? 'absent' : 'invalid',
        reason: r.reason,
        kitVersion: undefined,
        files: 0,
        mismatch: 0,
      };
    }
    const files = r.p.manifest.files.filter((f) => f.target === 'home');
    const mismatch = files.filter((f) => r.p.payloadSha[f.payload_path] !== f.sha256).length;
    return {
      state: 'ok',
      reason: undefined,
      kitVersion: r.p.manifest.kit_version,
      files: files.length,
      mismatch,
    };
  }

  // ---- 快照与计划 ----

  private homeFiles(m: PayloadManifest | null): PayloadFile[] {
    return (m?.files ?? []).filter((f) => f.target === 'home');
  }

  /** 计划涉及的 agent:默认同步集合 ∪ 登记表里出现过的 */
  async agentsInUse(): Promise<RenderAgentId[]> {
    const l = await this.ledger();
    const set = new Set<RenderAgentId>(DEFAULT_SYNC_AGENTS);
    for (const e of l?.entries ?? []) for (const a of e.agents) set.add(a);
    return [...set].sort();
  }

  snapshot(): Promise<SnapshotResult | null> {
    return this.once('snapshot', async () => {
      const lr = await this.ledgerRead();
      if (lr.state === 'unsafe') return null;
      const pl = await this.payload();
      const paths = new Set<string>([CODEX_MD, PI_MD]);
      const blockIds: Record<string, string[]> = {};
      const addBlock = (p: string, id: string | undefined): void => {
        if (id === undefined) return;
        const l = (blockIds[p] ??= []);
        if (!l.includes(id)) l.push(id);
      };
      for (const f of this.homeFiles(pl.p?.manifest ?? null)) {
        paths.add(f.path);
        addBlock(f.path, f.block_id);
      }
      const ledgerPaths: string[] = [];
      if (lr.state === 'ok') {
        for (const e of lr.ledger.entries) {
          paths.add(e.path);
          ledgerPaths.push(e.path);
          addBlock(e.path, e.block_id);
        }
      }
      return buildDiskSnapshot({
        home: this.a.home,
        paths: [...paths],
        blockIds,
        ledgerPaths,
        ownedDirs: OWNED_DIRS,
      });
    });
  }

  plan(): Promise<SyncPlan | null> {
    return this.once('plan', async () => {
      const pl = await this.payload();
      const snap = await this.snapshot();
      const lr = await this.ledgerRead();
      if (pl.p === null || snap === null || lr.state === 'unsafe') return null;
      return planSync({
        payload: pl.p.manifest,
        payloadSha256: pl.p.manifestSha256,
        payloadSha: pl.p.payloadSha,
        ledger: lr.state === 'ok' ? lr.ledger : lr.state === 'invalid' ? ({} as SyncLedger) : null,
        disk: snap.snapshot,
        options: {
          agents: await this.agentsInUse(),
          overwriteDrifted: false,
          uninstall: false,
          adopt: false,
          txnId: NO_TXN,
        },
      });
    });
  }

  async d05(): Promise<readonly D05Entry[] | null> {
    const l = await this.ledger();
    const snap = await this.snapshot();
    if (l === null || snap === null) return null;
    const missing: DiskEntry = { kind: 'missing' };
    return l.entries.map((entry) => ({
      entry,
      disk: snap.snapshot.entries[entry.path] ?? missing,
    }));
  }

  async d06(): Promise<D06Target[]> {
    const l = await this.ledger();
    const snap = await this.snapshot();
    if (snap === null) return [];
    const pl = await this.payload();
    const seen = new Map<string, D06Target>();
    const missing: DiskEntry = { kind: 'missing' };
    for (const e of l?.entries ?? []) {
      if (e.block_id === undefined) continue;
      seen.set(`${e.path}\0${e.block_id}`, {
        path: e.path,
        blockId: e.block_id,
        disk: snap.snapshot.entries[e.path] ?? missing,
        inLedger: true,
      });
    }
    for (const f of this.homeFiles(pl.p?.manifest ?? null)) {
      if (f.block_id === undefined) continue;
      const k = `${f.path}\0${f.block_id}`;
      if (seen.has(k)) continue;
      seen.set(k, {
        path: f.path,
        blockId: f.block_id,
        disk: snap.snapshot.entries[f.path] ?? missing,
        inLedger: false,
      });
    }
    return [...seen.values()];
  }

  // ---- D09 ----

  async d09(): Promise<D09Input> {
    const home = this.a.home;
    const sizeOf = async (rel: string): Promise<number | null> =>
      safely(async () => {
        const l = await lstatOrNull(join(home, rel));
        if (l === null) return null;
        return (l.isSymbolicLink() ? await stat(join(home, rel)) : l).size;
      }, null);
    const codex = await sizeOf('.codex/AGENTS.override.md');
    const pi = await sizeOf('.pi/agent/AGENTS.override.md');
    const l = await this.ledger();
    const pl = await this.payload();
    const claudeRulesUsed =
      (l?.entries ?? []).some((e) => e.path.startsWith('.claude/rules/agent-kit/')) ||
      this.homeFiles(pl.p?.manifest ?? null).some(
        (f) => f.agent === 'claude' && f.path.startsWith('.claude/rules/agent-kit/'),
      );
    const piDir = this.a.env['PI_CODING_AGENT_DIR'];
    return {
      codexOverride: codex === null ? 'absent' : codex === 0 ? 'empty' : 'nonempty',
      piOverride: pi !== null,
      piAgentDirEnv: piDir !== undefined && piDir !== '',
      claudeRulesUsed,
    };
  }

  // ---- D10 ----

  async d10(): Promise<D10Input> {
    const snap = await this.snapshot();
    const pl = await this.payload();
    const cfg = await safely(async () => loadKitConfig(this.a.repoRoot).config?.budget, undefined);
    const limitsSource = cfg === undefined ? ('builtin' as const) : ('kit_toml' as const);
    const limitsOf = (
      agent: 'codex' | 'pi',
    ): { maxBytes?: number; hardLimit?: number | 'unknown' } => {
      const t = cfg?.[agent];
      if (t !== undefined) {
        return {
          ...(t.max_bytes !== undefined ? { maxBytes: t.max_bytes } : {}),
          ...(t.hard_limit !== undefined ? { hardLimit: t.hard_limit } : {}),
        };
      }
      return agent === 'codex' && cfg === undefined ? { hardLimit: 32768 } : {};
    };
    const targets: D10Target[] = [];
    for (const [agent, rel] of [
      ['codex', CODEX_MD],
      ['pi', PI_MD],
    ] as const) {
      const lim = limitsOf(agent);
      if (lim.maxBytes === undefined && lim.hardLimit === undefined) continue;
      let bytes: number | null = null;
      const disk = snap?.snapshot.entries[rel];
      if (snap !== null && disk !== undefined) {
        const existing = disk.kind === 'file' ? snap.texts.get(rel) : undefined;
        if (disk.kind === 'file' || disk.kind === 'missing') {
          // 落盘后的整个文件 = 现有内容(含用户自己的部分)与 payload 的托管块合并之后
          const pf = this.homeFiles(pl.p?.manifest ?? null).find(
            (f) => f.agent === agent && f.path === rel && f.mode === 'managed-block',
          );
          let projected = existing;
          const text =
            pf !== undefined && pl.p !== null ? pl.p.contents.get(pf.payload_path) : undefined;
          if (pf?.block_id !== undefined && text !== undefined) {
            const parsed = parseManagedBlocks(text);
            const block = parsed.ok ? parsed.blocks.find((b) => b.id === pf.block_id) : undefined;
            if (block !== undefined) {
              try {
                projected = applyManagedBlock(existing, pf.block_id, block.body, {
                  onDrift: 'overwrite',
                }).content;
              } catch {
                projected = existing; // 现有文件的托管块损坏:按现状量(D06 会报 corrupt)
              }
            }
          }
          bytes = projected === undefined ? null : Buffer.byteLength(projected, 'utf8');
        }
      }
      targets.push({ agent, bytes, ...lim });
    }
    return {
      targets,
      thresholdPercent: cfg?.threshold_percent ?? 90,
      limitsSource,
    };
  }

  // ---- D11 ----

  async d11(): Promise<D11Input> {
    const pl = await this.payload();
    const conditionals = this.homeFiles(pl.p?.manifest ?? null).filter(
      (f) => f.conditional !== undefined,
    );
    const tested = await (this.a.deps.testedVersions ?? defaultTested)();
    return {
      pendingProbes: pl.p === null ? null : conditionals.length,
      testedVersions: tested,
      inUse: await this.agentsInUse(),
    };
  }

  // ---- D15 ----

  async d15(): Promise<D15Input> {
    let overlay: D15Input['overlay'] = 'none';
    let egress: boolean | undefined;
    let slots = 0;
    let tz = 'UTC';
    if (this.a.overlayPath !== undefined) {
      const loaded = await safely(
        async () => loadOverlayFile(this.a.overlayPath as string),
        undefined,
      );
      if (loaded?.overlay === undefined) overlay = 'invalid';
      else {
        overlay = 'ok';
        const r = loaded.overlay.reflect;
        egress = r?.egress ?? false;
        slots = (r?.backends ?? []).filter((b) => b.allow_unverified === true).length;
        tz = r?.reset_tz ?? 'UTC';
      }
    }
    const dir = path.join(this.a.stateDir, 'llm-cooldown');
    const dst = await safely(() => lstatOrNull(dir), null);
    const present = dst !== null && dst.isDirectory() && !dst.isSymbolicLink();
    const today = dayKey((this.a.deps.now ?? (() => new Date()))(), tz);
    const slotsToday: string[] = [];
    if (present) {
      const re = new RegExp(`^(${JUDGE_HOP_CHAIN.join('|')})-(\\d{8})$`);
      for (const e of await safely(() => readDir(dir), [])) {
        const m = re.exec(e.name);
        if (m !== null && m[2] === today && e.isFile) slotsToday.push(m[1] as string);
      }
    }
    return {
      overlay,
      egress,
      unverifiedSlots: slots,
      cooldownToday: slotsToday.sort(),
      cooldownDir: present ? 'present' : 'absent',
    };
  }
}

function dayKey(now: Date, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year').padStart(4, '0')}${get('month')}${get('day')}`;
}

function defaultTested(): Promise<Record<string, number>> {
  return Promise.resolve(
    Object.fromEntries(defaultRegistry.list().map((a) => [a.agent, a.testedVersions.length])),
  );
}

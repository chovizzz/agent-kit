/**
 * R20-A2 B3c 服务层测试共用夹具:真实目录、真实 rsi 配置、真实锁、真实暂存区 / 信号库 / 索引 / counts。
 * 全部经 safe-fs 写在 KIT_TMP 内;不碰真实 HOME;不 import node:fs。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { stringify } from 'yaml';
import { canonicalJson } from '../../src/io/canonical-json.js';
import type { IoContext } from '../../src/io/paths.js';
import { lstat, readBytes, readDir, stat } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { loadRsiConfig, type RsiConfigOn } from '../../src/rsi/config.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { acquireRsiLock, type RsiLockHandle } from '../../src/rsi/lock.js';
import type { RsiServiceCtx } from '../../src/rsi/types.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

export const SALT = 'ab'.repeat(32);
export const SALT_FP = createHash('sha256').update(SALT).digest('hex').slice(0, 12);
export const EXCERPT_MARK = 'SECRET-EXCERPT-0451';

export interface Svc {
  f: RsiFx;
  io: IoContext;
  cfg: RsiConfigOn;
  ctx: RsiServiceCtx;
  audit: string[];
  state: string;
  rsi: string;
  clock: { t: number };
}

export interface MakeSvcOptions {
  /** 追加到 `[rsi]` 段的 TOML(如 `exclude_dirs = [...]`);给函数时可按夹具目录拼路径 */
  extraToml?: string | ((f: RsiFx) => string);
  /** 写盐(缺省 true) */
  salt?: boolean;
}

export async function makeSvc(prefix: string, opts: MakeSvcOptions = {}): Promise<Svc> {
  const f = await makeRsiFx(prefix);
  const extra = typeof opts.extraToml === 'function' ? opts.extraToml(f) : (opts.extraToml ?? '');
  await writeCfg(f, rsiToml(f, extra));
  // KIT_TMP 不得是(假)HOME 的上级:取 repo(与 home 同级)
  const env = { KIT_TMP: f.repo, KIT_REAL_HOME_OVERRIDE: f.home, PATH: '/usr/bin:/bin' };
  const cfg = await loadRsiConfig({ home: f.home });
  if (cfg.status !== 'on') throw new Error(`rsi config off (${cfg.reason})`);
  const audit: string[] = [];
  const io = createRsiIoContext({
    repo: f.repo,
    env,
    cwd: f.repo,
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  const clock = { t: Date.parse('2026-10-26T12:00:00.000Z') };
  // 真实 HOME 不得参与:服务层读配置用 io.hostEnv.HOME,必须是假 HOME
  if (io.hostEnv['HOME'] !== f.home) throw new Error('fixture: hostEnv.HOME 不是假 HOME');
  const state = path.join(f.repo, '.state');
  const svc: Svc = {
    f,
    io,
    cfg,
    ctx: { io, config: cfg, now: () => new Date(clock.t) },
    audit,
    state,
    rsi: path.join(state, 'rsi'),
    clock,
  };
  if (opts.salt !== false) await put(svc, path.join(state, 'salt'), SALT, 0o600);
  return svc;
}

/** 改配置文件(下一次重读即生效) */
export async function setRsiToml(s: Svc, extra: string): Promise<void> {
  await writeCfg(s.f, rsiToml(s.f, extra));
}

export async function put(s: Svc, abs: string, content: string, mode = 0o600): Promise<void> {
  await mkdirp(s.f.fx, path.dirname(abs), 0o700);
  await writeFile(s.f.fx, abs, content, { mode });
  await chmod(s.f.fx, abs, mode);
}

export async function rm(s: Svc, abs: string): Promise<void> {
  await remove(s.f.fx, abs);
}

export async function withLock<T>(s: Svc, fn: (lock: RsiLockHandle) => Promise<T>): Promise<T> {
  const lock = await acquireRsiLock(s.io);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

/** 一份合法的信号;`id` 是 16 位十六进制 */
export function signalObj(id: string, key: string): Record<string, unknown> {
  return {
    sig_id: `sig_${id}`,
    agent: 'claude',
    agent_version: '1.0.0',
    agent_version_source: 'session_meta',
    session_ref: 's_0123456789abcdef',
    project_key: key,
    ts: '2026-10-01T00:00:00.000Z',
    type: 'event',
    excerpt_redacted: 'hello',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
  };
}

export async function addSignals(
  s: Svc,
  list: readonly { id: string; key: string }[],
  month = '202610',
): Promise<void> {
  const file = path.join(s.state, 'signals', 'claude', `${month}.jsonl`);
  const lines = list.map((x) => JSON.stringify(signalObj(x.id, x.key)));
  await put(s, file, `${lines.join('\n')}\n`, 0o600);
}

export const KEY_A = 'p_aaaaaaaaaaaaaaaa';
export const KEY_B = 'p_bbbbbbbbbbbbbbbb';
export const KEY_C = 'p_cccccccccccccccc';

/** 项目根路径(夹具目录下的确定路径,不创建) */
export const projPath = (f: RsiFx, name: string): string => path.join(f.dir, 'proj', name);

/** 建项目根目录(真实目录) */
export async function makeRoot(s: Svc, name: string): Promise<string> {
  const p = projPath(s.f, name);
  await mkdirp(s.f.fx, p, 0o755);
  return p;
}

export async function writeIndex(
  s: Svc,
  entries: readonly { key: string; root: string }[],
  saltFp: string = SALT_FP,
): Promise<void> {
  const out = [];
  for (const e of [...entries].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const st = await stat(e.root);
    out.push({
      key: e.key,
      roots: [
        {
          path: e.root,
          dev: st.dev,
          ino: st.ino,
          first_seen: '2026-10-01',
          last_seen: '2026-10-02',
        },
      ],
      sessions: 1,
      signals: 1,
      first_indexed_generation: 1,
    });
  }
  const doc = { schema_version: 1, salt_fp: saltFp, generation: 1, entries: out };
  await put(s, path.join(s.rsi, 'projects.json'), canonicalJson(doc), 0o600);
  await mkdirp(s.f.fx, s.rsi, 0o700);
}

export function countsDoc(
  saltFp: string = SALT_FP,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    salt_fp: saltFp,
    generation: 1,
    computed_at: '2026-10-26T00:00:00.000Z',
    cluster_min: 2,
    per_key: {},
    clusters: [],
    staged: [],
    unknown_keys_signals: 0,
    ...extra,
  };
}

export async function writeCountsRaw(s: Svc, doc: Record<string, unknown>): Promise<void> {
  await put(s, path.join(s.rsi, 'counts.json'), canonicalJson(doc), 0o600);
}

/** 让 rsi 目录存在且权限合规(0700) */
export async function ensureRsiDir(s: Svc): Promise<void> {
  await mkdirp(s.f.fx, s.rsi, 0o700);
  await chmod(s.f.fx, s.rsi, 0o700);
}

export const runDirOf = (s: Svc, id: string): string => path.join(s.state, 'reflect', id);
export const promoteDirOf = (s: Svc, id: string): string => path.join(s.state, 'promote', id);

/**
 * 暂存一个 run:`proposals/<pid>.yaml`(证据 sig + 摘录)、`rules/team/<atom>.md`(frontmatter 证据 ref + 摘录)、`apply.patch`(含摘录)、`report.json`。
 * 每处摘录都是 {@link EXCERPT_MARK},方便断言「全部摘录为空」。
 */
export async function stageRun(
  s: Svc,
  runId: string,
  sigs: readonly string[],
  opts: { proposals?: number; extraFiles?: Record<string, string> } = {},
): Promise<void> {
  const dir = runDirOf(s, runId);
  const n = opts.proposals ?? 1;
  for (let i = 1; i <= n; i++) {
    const pid = `2026-10-26-${String(i).padStart(3, '0')}`;
    const atom = `atom-${runId}-${i}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const proposal = {
      id: pid,
      op: 'add',
      targets: [atom],
      layer: 'team',
      rationale: 'why',
      evidence: sigs.map((sig) => ({
        sig: `sig_${sig}`,
        project_key: 'p_unused',
        excerpt: EXCERPT_MARK,
      })),
      budget_delta_bytes: 10,
      paired_retirements: [],
      cases: [],
      reflector: { provider: 'x', vendor: 'v', model: 'm', run_id: runId },
    };
    await put(s, path.join(dir, 'proposals', `${pid}.yaml`), stringify(proposal, { lineWidth: 0 }));
    const fm = {
      id: atom,
      title: 'T',
      layer: 'team',
      strength: 'should',
      kind: 'preference',
      volatility: 'stable',
      status: 'proposed',
      owner: 'o',
      created: '2026-10-26',
      review_by: '2027-01-26',
      evidence: sigs.map((sig) => ({ type: 'trace', ref: `sig_${sig}`, excerpt: EXCERPT_MARK })),
      verifier: { type: 'none' },
    };
    await put(
      s,
      path.join(dir, 'rules', 'team', `${atom}.md`),
      `---\n${stringify(fm, { lineWidth: 0 })}---\n\n**做**:do BODY-KEEP\n**为什么**:why\n**怎么验**:verify\n`,
    );
  }
  await put(s, path.join(dir, 'apply.patch'), `diff --git a/x b/x\n+${EXCERPT_MARK}\n`);
  await put(
    s,
    path.join(dir, 'report.json'),
    `${JSON.stringify({ run_id: runId, proposals: n })}\n`,
  );
  for (const [name, body] of Object.entries(opts.extraFiles ?? {})) {
    await put(s, path.join(dir, name), body);
  }
}

export async function stagePromote(s: Svc, promoId: string, runId: string | null): Promise<void> {
  const dir = promoteDirOf(s, promoId);
  await put(s, path.join(dir, 'promote.patch'), `diff\n+${EXCERPT_MARK}\n`);
  await put(s, path.join(dir, 'pr-body.md'), `body ${EXCERPT_MARK}\n`);
  await put(
    s,
    path.join(dir, 'report.json'),
    runId === null ? 'not json' : `${JSON.stringify({ run_id: runId, promo_id: promoId })}\n`,
  );
}

/** 目录下所有文件的相对路径(升序,不跟随链接) */
export async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readDir(path.join(root, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory && !e.isSymbolicLink) out.push(...(await listFiles(root, r)));
    else out.push(r);
  }
  return out;
}

/** 目录下全部文件内容拼成一个字符串(找摘录泄漏用) */
export async function allText(root: string): Promise<string> {
  const parts: string[] = [];
  for (const rel of await listFiles(root)) {
    const st = await lstat(path.join(root, rel));
    if (st.isFile())
      parts.push(Buffer.from(await readBytes(path.join(root, rel))).toString('utf8'));
  }
  return parts.join('\n');
}

export class CrashError extends Error {}

/** 在第 n 次(从 1 起)命中 `name` 时抛 CrashError;`hits` 记录全部点名顺序 */
export function crashAt(name: string, nth = 1): { point: (n: string) => void; hits: string[] } {
  const hits: string[] = [];
  let seen = 0;
  return {
    hits,
    point(n: string): void {
      hits.push(n);
      if (n === name && ++seen === nth) throw new CrashError(`crash at ${n}`);
    },
  };
}

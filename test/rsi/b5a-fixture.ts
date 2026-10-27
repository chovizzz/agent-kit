/**
 * B5a 命令级测试夹具:真实 `[rsi]` 配置 / 假 HOME / 真实持锁写入方造出的状态;命令经 runTick 等入口函数直接调用(带 deps 缝),
 * 写审计由**外部数组**累计(可在 deps 钩子里读到实时长度,用于「失锁之后零写入」)。会话文件写在假 HOME 下的 claude 根。
 */
import * as path from 'node:path';
import type { RsiConfirm } from '../../src/contracts/rsi.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import type { RsiEarlyContext } from '../../src/rsi/types.js';
import { claudeLine, jl, put as putSession, uuid } from './l0-fixture.js';
import { baseState, makeRoFx, mkProject, seed, validConfirm, type RoFx } from './ro-fixture.js';
import type { AuditCall } from '../helpers/write-audit.js';

export interface TickFx extends RoFx {
  /** 外部累计的写审计(只有命令经 `runCmd` 的调用会记进来;夹具自己的造数据不计) */
  audit: AuditCall[];
  rsiDir: string;
}

export interface TickFxOptions {
  /** 追加到 `[rsi]` 的 TOML */
  extra?: string;
  /** 已确认状态(默认 false = 首次 armed);`baseline_pending` 为 true */
  confirmed?: boolean;
  /** 会话数(每个项目 1 个 claude 会话);默认 2 */
  projects?: number;
  /** 额外塞进 state.json 的字段 */
  state?: Record<string, unknown>;
  /** 不 seed(`.state/rsi/` 也不建) */
  noSeed?: boolean;
}

export async function makeTickFx(prefix: string, o: TickFxOptions = {}): Promise<TickFx> {
  const f = await makeRoFx(prefix, o.extra ?? '');
  const n = o.projects ?? 2;
  for (let i = 1; i <= n; i++) {
    const p = await mkProject(f, `proj${i}`);
    await putSession(
      f,
      'claude',
      `p/${uuid(i)}.jsonl`,
      jl(
        claudeLine(p.path, {
          timestamp: `2026-10-0${i}T00:00:00.000Z`,
          message: { role: 'user', content: 'from now on stop running the slow suite' },
        }),
        claudeLine(p.path, { timestamp: `2026-10-0${i}T00:00:01.000Z` }),
      ),
    );
  }
  const fx: TickFx = { ...f, audit: [], rsiDir: path.join(f.io.stateDir, 'rsi') };
  if (o.noSeed !== true) {
    const confirm: RsiConfirm | null =
      o.confirmed === true ? { ...(await validConfirm(f)), baseline_pending: true } : null;
    await seed(f, { state: baseState({ confirm, ...(o.state ?? {}) }) });
  }
  return fx;
}

/** 直接调命令函数,写审计累计到 `f.audit`(外部数组) */
export interface CmdFx {
  env: Record<string, string>;
  dir: string;
  audit: AuditCall[];
}

export async function runCmd<D>(
  f: CmdFx,
  run: (ctx: RsiEarlyContext, deps: D) => Promise<number>,
  argv: string[],
  deps: D,
  over: {
    env?: Record<string, string | undefined>;
    isTty?: boolean;
    readLine?: () => Promise<string | undefined>;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(
    {
      argv,
      overlayPath: undefined,
      explicitRoot: undefined,
      env: { ...f.env, ...over.env },
      cwd: f.dir,
      writeAudit: (op, p) => void f.audit.push({ op, path: p }),
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      ...(over.isTty !== undefined ? { isTty: over.isTty } : {}),
      ...(over.readLine !== undefined ? { readLine: over.readLine } : {}),
    },
    deps,
  );
  return { code, out, err };
}

/** 换掉锁文件的 nonce(「失锁」):下一次 `assertHeld` 报 lock_lost */
export async function loseLockOf(f: TickFx): Promise<void> {
  await remove(f.fx, path.join(f.rsiDir, 'lock'));
}

export async function rsiJson(f: TickFx, name: string): Promise<Record<string, unknown> | null> {
  const p = path.join(f.rsiDir, name);
  return (await exists(p)) ? (JSON.parse(await readText(p)) as Record<string, unknown>) : null;
}

/** 覆盖写 `.state/rsi/<name>`(造「清单与文件不一致」等) */
export async function overwriteRsi(f: TickFx, name: string, body: unknown): Promise<void> {
  await writeFile(
    f.io,
    path.join(f.rsiDir, name),
    typeof body === 'string' ? body : canonicalJson(body),
    {
      mode: 0o600,
    },
  );
}

export const writeKinds = (calls: readonly AuditCall[]): string[] =>
  calls.map((c) => `${c.op} ${path.basename(c.path)}`);

/** 另一个进程持锁的模拟:写一份 pid = 父进程(存活)的新鲜锁文件。同进程里再 `acquireRsiLock` 会因「不重入」报 internal,所以不能用它造「被占用」 */
export async function foreignLock(f: TickFx): Promise<() => Promise<void>> {
  const file = path.join(f.rsiDir, 'lock');
  const doc = {
    pid: process.ppid,
    started_at: new Date().toISOString(),
    nonce: 'f'.repeat(16),
    kit_version: '0.0.0',
  };
  await mkdirp(f.fx, f.rsiDir, 0o700);
  await writeFile(f.io, file, canonicalJson(doc), { mode: 0o600 });
  return () => remove(f.fx, file);
}

/** 服务层夹具(`makeSvc`)上跑命令:env 与夹具一致(假 HOME / KIT_TMP = repo) */
export function cmdFxOf(s: { f: { repo: string; home: string; dir: string } }): CmdFx {
  return {
    env: { KIT_TMP: s.f.repo, KIT_REAL_HOME_OVERRIDE: s.f.home, PATH: '/usr/bin:/bin' },
    dir: s.f.dir,
    audit: [],
  };
}

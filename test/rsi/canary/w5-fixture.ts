/**
 * W5 测试夹具:假 HOME / 状态目录、`canary.json` / 准入条目构造器、内存许可端口。
 * **不调用被测判定**:期望值由测试自己手写。
 */
import * as path from 'node:path';
import type {
  CanaryAdmission,
  CanaryDoc,
  RsiRevocationLine,
} from '../../../src/contracts/rsi-personal.js';
import { createIoContext, type IoContext } from '../../../src/io/paths.js';
import { readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import type { CanaryRunEnv } from '../../../src/rsi/canary/canary-hint.js';
import type { AdmissionEntry } from '../../../src/rsi/canary/canary-decide.js';
import type { PauseRead, PermitPort, Read3 } from '../../../src/rsi/canary/permit-read.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { baseCtx, makeTempDir, REPO_ROOT } from '../../helpers/tmp.js';

export const T0 = Date.parse('2026-11-10T12:00:00Z');
export const CID = 'ra_0123456789ab';
export const OTHER_CID = 'ra_ba9876543210';
export const SHA = 'a'.repeat(64);
export const POLICY = 'b'.repeat(64);
export const BODY =
  '做:运行测试之前先确认依赖已经安装。\n为什么:缺少依赖时测试会以难懂的方式失败。';

export interface CanaryWorld {
  dir: string;
  io: IoContext;
  /** `.state/rsi` 的真实路径(0700) */
  rsi: string;
  home: string;
}

export async function makeCanaryWorld(prefix: string): Promise<CanaryWorld> {
  const { dir } = await makeTempDir(prefix);
  const io = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: baseCtx().execPath },
  });
  const rsi = await rsiDir(io);
  const home = path.join(dir, 'home');
  await safe.mkdirp(io, home, 0o700);
  return { dir, io, rsi, home };
}

export function canaryDoc(over: Partial<CanaryDoc> = {}): CanaryDoc {
  return {
    candidate_id: CID,
    content_sha256: SHA,
    body: BODY,
    content_sha12: SHA.slice(0, 12),
    p_by_agent: { claude: 0.5 },
    agents_inject: ['claude'],
    background_fp: '1'.repeat(16),
    background_fp_ex: '2'.repeat(16),
    policy_fp: POLICY,
    revocation_gen: 0,
    generation: 1,
    overlaps_preset: false,
    ...over,
  };
}

export function admitted(over: Partial<AdmissionEntry> = {}): AdmissionEntry {
  return {
    state: 'admitted',
    shape_version: 'claude-1',
    agent_version: '2.1.0',
    generation: 1,
    armed_at: '2026-11-09T00:00:00Z',
    probe_expires_at: '2026-11-16T00:00:00Z',
    tickets: 3,
    decided_at: '2026-11-09T05:00:00Z',
    reason: null,
    ...over,
  };
}

export function probing(over: Partial<AdmissionEntry> = {}): AdmissionEntry {
  return admitted({ state: 'probing', decided_at: null, ...over });
}

export const adm = (e: AdmissionEntry, agent: 'claude' | 'pi' = 'claude'): CanaryAdmission => ({
  schema_version: 1,
  agents: agent === 'claude' ? { claude: e } : { pi: e },
});

export const REVOKE = (
  id = CID,
  sha = SHA,
  reason: RsiRevocationLine['reason'] = 'cleared',
): RsiRevocationLine => ({
  at: '2026-11-10T11:00:00Z',
  candidate_id: id,
  content_sha256: sha,
  identity12: null,
  reason,
  by: 'clear',
});

export interface PortState {
  pause?: PauseRead;
  admission?: Read3<CanaryAdmission>;
  canary?: Read3<CanaryDoc>;
  revocations?: Read3<readonly RsiRevocationLine[]>;
}

/** 内存许可端口(与生产端口同契约:读失败 = `unreadable`,从不返回「空」冒充成功);记录被读取的输入 */
export function fakePort(s: PortState = {}): PermitPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pause: async () => {
      calls.push('pause');
      return s.pause ?? 'absent';
    },
    admission: async () => {
      calls.push('admission');
      return s.admission ?? { kind: 'absent' };
    },
    canary: async () => {
      calls.push('canary');
      return s.canary ?? { kind: 'absent' };
    },
    revocations: async () => {
      calls.push('revocations');
      return s.revocations ?? { kind: 'absent' };
    },
  };
}

export const ok = <T>(value: T): Read3<T> => ({ kind: 'ok', value });

/** 读分组账(测试自己解析,不经被测的读取函数) */
export async function ledgerRows(w: CanaryWorld): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readText(path.join(w.rsi, 'canary-ledger.jsonl'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text === ''
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function runEnv(
  w: CanaryWorld,
  port: PermitPort,
  over: Partial<CanaryRunEnv> = {},
): CanaryRunEnv {
  let n = 0;
  return {
    agent: 'claude',
    autoLoopEffective: true,
    phase: 2,
    policyFp: POLICY,
    shapeVersion: 'claude-1',
    agentVersion: '2.1.0',
    nowMs: T0,
    port,
    io: w.io,
    rsiDir: w.rsi,
    now: () => new Date(T0),
    random: () => 0.1,
    randomBytes: (k) => new Uint8Array(k).fill(++n),
    over: () => false,
    ...over,
  };
}

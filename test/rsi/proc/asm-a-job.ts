/**
 * 装配块 A 段「空写入根」子进程用例的作业体:同一份代码既在进程内跑(基准),也被 `asm-a-entry.ts` 打包后在真子进程里跑
 * (`KIT_WRITE_ROOTS=:` = 写入根集合为空,safe-fs 一律拒写)。读作业对**真实**只读适配器(`assembleReadAdapters`)逐端口取值,把每个结果(或错误名)收成一个对象;
 * `commands` 作业(W8a 遗留的零写入层 ②):对**生产组装**(`productionAutoPorts`:不给 gitPath = 未装配)经 `runAutoFamily` 直接跑五类只读命令——`phase: 2` 只经
 * deps 参数注入(与 `test/rsi/auto/zero-write.test.ts` 的 `runDirect` 同一条缝,**不加任何相位环境变量**,所以不是生产后门);每条命令收 `{code, out, err, audit}`。
 * 写探针(对照)直接用 safe-fs 写一次,证明「空写入根」确实在起作用。
 * 子进程里不读 `process.env`:全部由作业给(与 ro-entry 同法);git 路径解析 = `null`(未装配),spawn 间谍一旦被调用就记下来并抛错。
 */
import * as path from 'node:path';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { mkdirp } from '../../../src/io/safe-fs.js';
import { getRealHome } from '../../../src/io/paths.js';
import { createRsiIoContext } from '../../../src/rsi/io.js';
import { assembleReadAdapters } from '../../../src/rsi/assemble-read.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';

export interface AsmAJob {
  kind: 'read' | 'commands' | 'write_probe';
  env: Record<string, string>;
  cwd: string;
  repo: string;
  /** 非空世界:包内 payload 的预置技能(`kind=skill`);缺省 = 空 payload */
  skills?: { payload_path: string; text: string }[];
  /** 非空世界:shadow 记录(`readySince.recover` 的输入);缺省 = 不调用 */
  shadowRec?: unknown;
}

export type AsmAResult = Record<string, unknown>;

/** 与 `test/rsi/auto/zero-write.test.ts` 的 `CASES` 同一集合 */
export const COMMAND_CASES: readonly (readonly [
  'auto' | 'report' | 'show' | 'rollback',
  readonly string[],
])[] = [
  ['auto', ['status']],
  ['auto', ['status', '--json']],
  ['auto', ['clear']],
  ['auto', ['clear', '--json']],
  ['report', []],
  ['report', ['--json', '--since', '2026-01-01']],
  ['show', ['ra_0123456789ab']],
  ['rollback', ['--to', '2026-11-01']],
  ['rollback', ['--to', '2026-11-01', '--json']],
];

const never = (): never => {
  throw new Error('redactor must not be used by the read job');
};

/** 一个端口调用 → `{ ok: 值 }` 或 `{ err: 错误名 }`(值必须可 JSON 化) */
async function take(f: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await f() };
  } catch (e) {
    return {
      err: e instanceof Error ? `${e.name}:${(e as { code?: string }).code ?? ''}` : 'throw',
    };
  }
}

export async function runAsmAJob(
  job: AsmAJob,
  audit?: { op: string; path: string }[],
): Promise<AsmAResult> {
  const io = createRsiIoContext({
    repo: job.repo,
    env: job.env,
    cwd: job.cwd,
    ...(audit !== undefined
      ? { writeAudit: (op: string, p: string) => void audit.push({ op, path: p }) }
      : {}),
  });
  if (job.kind === 'commands') {
    const out: AsmAResult = {};
    for (const [family, argv] of COMMAND_CASES) {
      const calls: { op: string; path: string }[] = [];
      let o = '';
      let e = '';
      const code = await runAutoFamily(
        family,
        {
          argv: [...argv],
          overlayPath: undefined,
          explicitRoot: undefined,
          env: job.env,
          cwd: job.cwd,
          writeAudit: (op: string, p: string) => void calls.push({ op, path: p }),
          stdout: (t: string) => (o += t),
          stderr: (t: string) => (e += t),
          isTty: true,
        },
        { phase: 2 },
      );
      out[`${family} ${argv.join(' ')}`] = { code, out: o, err: e, audit: calls };
    }
    return out;
  }
  if (job.kind === 'write_probe') {
    return {
      probe: await take(async () => {
        await mkdirp(io, path.join(io.stateDir, 'asm-a-probe'), 0o700);
        return true;
      }),
    };
  }
  const home = getRealHome(job.env);
  const spawnCalls: string[] = [];
  const a = assembleReadAdapters({
    io,
    home,
    rsiDir: path.join(io.stateDir, 'rsi'),
    gitDir: path.join(home, '.local/share/agent-kit/personal/.git'),
    cfg: { excludeDirs: [], excludeNames: [] },
    redactor: { pass2: never },
    gitPath: async () => null,
    gitSpawn: () => {
      spawnCalls.push('spawn');
      throw new Error('spawn must not be called');
    },
    payload: async () => ({
      manifest: {
        files: (job.skills ?? []).map((k) => ({ kind: 'skill', payload_path: k.payload_path })),
      },
      contents: new Map((job.skills ?? []).map((k) => [k.payload_path, k.text])),
    }),
  });
  const since = '2026-11-01T00:00:00Z';
  const out: AsmAResult = {
    recorded: await take(() => a.recorded.readCommit('a'.repeat(40))),
    peekRecords: await take(() => a.peekRecords()),
    peekRecord: await take(() => a.peekRecord('ra_0123456789ab')),
    recordedSha: await take(() => a.recordedSha('ra_0123456789ab')),
    revocations: await take(() => a.revocations.read()),
    breaker: await take(() => a.breaker.read()),
    staged: await take(() => a.staged.list()),
    signals: await take(() => a.signals.getMany(['sig_0000000000000001'])),
    presets: await take(() => a.presets.presets()),
    ledger: await take(() => a.analysis.ledger()),
    stats: await take(() => a.analysis.stats(since)),
    analysisSignals: await take(() => a.analysis.signals(since)),
    c4Bytes: await take(() => a.analysis.c4Bytes()),
    collectedThrough: await take(() => a.analysis.collectedThrough()),
    payloadDrift: await take(() => a.analysis.payloadDrift()),
    classify: await take(() => a.analysis.classify('p_0000000000000000')),
    ...(job.shadowRec === undefined
      ? {}
      : {
          readySince: await take(() =>
            a.readySince.recover(job.shadowRec as PersonalLifecycleRecord),
          ),
        }),
    spawnCalls,
  };
  return out;
}

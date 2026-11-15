/**
 * 装配块 A 段的**读侧组合根**(§21 V1 装配):把本段的全部只读适配器按窄端口组装起来。SOLID:业务依赖端口,具体实现在这里注入;
 * 子进程出口(`spawn`)、git 路径解析、包内 payload 读取都由部署侧以参数传入,**本文件不 import 任何写出口 / 锁 / 子进程启动器**
 * (闭包由 `test/rsi/asm/a-zero-write.test.ts` 与 `import-closure.test.ts` 的现有断言约束;读 / 写组合入口互不穿越:写侧组合根是 B 段的 `assemble-command.ts`,worker 侧是 C / D 段)。
 *
 * **工厂创建与 import 不读盘、不起子进程、不读环境变量**(单测以 read-fs 计数断言):所有 I/O 都在端口方法被调用时才发生;
 * 分类器实例在第一次需要时现建、此后在**本次装配的生命周期内**复用(`attribution.ts`:缓存只活在一个实例内)——装配应当按一次 worker / 命令运行新建,不跨运行持有。
 *
 * `recorded` 的装配:`gitPath()` 解析不到(`null`)→ 保持 `unwiredRecordedRead`(`unreadable(not_wired)`,命令退 3),绝不假装成功。
 * 本段**不**把 `resolveGitPath` 接进 `deps.ts` 的生产缺省:contracts §21.24 W0-22 第 6 条要求「`.git` 收紧 0700 之前 `gitPath` 保持未装配」,该前置未满足(见交付汇报「问题」)。
 */
import type { Redactor } from '../contracts/redact.js';
import type { IoContext } from '../io/paths.js';
import { makeBreakerMarkerReader } from './canary/pause-marker-read.js';
import { readLedger } from './canary/ledger-read.js';
import { makeAnalysisSource } from './analysis/read.js';
import { makeAnalysisReadPorts } from './analysis/source-ports.js';
import type { AnalysisSource } from './analysis/run.js';
import type { RsiConfigOn } from './config.js';
import { makePeekRecord, makePeekRecords, makeRecordedShaRead } from './auto/read/peek.js';
import type { HomeReadPort } from './auto/read/ports.js';
import { makeRevocationReadAdapter } from './personal/read/credentials.js';
import { makeGitReadonly, type GitSpawn } from './personal/read/git-readonly.js';
import { makeHomeReadPort } from './personal/read/home-reads.js';
import { unwiredRecordedRead, type RecordedReadPort } from './personal/read/recorded-port.js';
import {
  makePresetSource,
  makeSignalLookup,
  makeStagedSource,
  type PresetPayload,
} from './personal/read/step-sources.js';
import type {
  PresetSource,
  ReadySinceRecovery,
  RecordRead,
  RepoRead,
  RevocationReader,
  SignalLookup,
  StagedSource,
} from './personal/candidate-ports.js';
import type { BreakerMarkerPort } from './personal/breaker.js';
import type { PersonalLifecycleRecord } from '../contracts/rsi-personal.js';
import { makeShadowObserver } from './personal/shadow-observe.js';
import { makeReadySinceRecovery } from './personal/shadow-facts.js';
import { RsiCountsSchema } from '../contracts/rsi.js';
import { classifierFor, readRsiFixed } from './services/attribution.js';

export interface AssembleReadDeps {
  /** 已就绪的 rsi io(`repoRoot` / `stateDir`) */
  io: IoContext;
  /** 已 realpath 的 HOME */
  home: string;
  /** 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录 */
  rsiDir: string;
  /** 私有仓库的 git 目录(绝对;由 HOME + 固定相对名现算,不来自用户输入) */
  gitDir: string;
  /** 当前配置的排除项(归属分类的输入) */
  cfg: Pick<RsiConfigOn, 'excludeDirs' | 'excludeNames'>;
  redactor: Pick<Redactor, 'pass2'>;
  /** git 绝对路径的解析(调用时才执行;`null` = 未装配)。生产 = `resolveGitPath`(见头注:本段不接进 deps.ts) */
  gitPath(): Promise<string | null>;
  /** 子进程出口(部署组装注入,生产 = `runGitClosed`);本文件不 import 它 */
  gitSpawn: GitSpawn;
  /** 包内 payload(`loadPayload` 的结果) */
  payload(): Promise<PresetPayload>;
}

export interface ReadAdapters {
  home: HomeReadPort;
  recorded: RecordedReadPort;
  peekRecord(id: string): Promise<RecordRead>;
  peekRecords(): Promise<RepoRead<PersonalLifecycleRecord[]>>;
  recordedSha(candidateId: string): Promise<string | null>;
  revocations: RevocationReader;
  breaker: Pick<BreakerMarkerPort, 'read'>;
  staged: StagedSource;
  signals: SignalLookup;
  presets: PresetSource;
  readySince: ReadySinceRecovery;
  analysis: AnalysisSource;
}

/** 惰性 `recorded`:第一次调用时才解析 git 路径;解析不到 → 与 `unwiredRecordedRead` 同一行为 */
function lazyRecorded(d: AssembleReadDeps): RecordedReadPort {
  let port: Promise<RecordedReadPort> | undefined;
  const get = (): Promise<RecordedReadPort> =>
    (port ??= d
      .gitPath()
      .then((g) =>
        g === null
          ? unwiredRecordedRead
          : makeGitReadonly({ gitPath: g, gitDir: d.gitDir, spawn: d.gitSpawn }),
      ));
  return {
    readCommit: async (oid) => (await get()).readCommit(oid),
    listTree: async (oid) => (await get()).listTree(oid),
    readBlob: async (oid) => (await get()).readBlob(oid),
  };
}

export function assembleReadAdapters(d: AssembleReadDeps): ReadAdapters {
  const home = makeHomeReadPort(d.home);
  const recorded = lazyRecorded(d);
  const src = { home, recorded };

  let classifier: Promise<(k: string) => Promise<'P' | 'X' | 'U'>> | undefined;
  const classify = async (k: string): Promise<'P' | 'X' | 'U'> =>
    (await (classifier ??= classifierFor(d.io, d.cfg)))(k);

  const readState = async (): Promise<Uint8Array | null> => {
    const r = await readRsiFixed(d.io, 'state.json');
    return r.kind === 'ok' ? r.bytes : null;
  };

  const observer = makeShadowObserver({
    io: d.io,
    classify,
    redactor: d.redactor,
    async ledgerMarkers() {
      const l = await readLedger(d.rsiDir);
      if (l.kind === 'invalid') throw new Error('ledger invalid');
      const out = new Set<string>();
      if (l.kind === 'ok') {
        for (const x of l.lines) if (x.kind === 'assign' && x.marker !== null) out.add(x.marker);
      }
      return out;
    },
  });

  return {
    home,
    recorded,
    peekRecord: makePeekRecord(src),
    peekRecords: makePeekRecords(src),
    recordedSha: makeRecordedShaRead(src),
    revocations: makeRevocationReadAdapter(home),
    breaker: makeBreakerMarkerReader(d.rsiDir),
    staged: makeStagedSource({
      io: d.io,
      classify,
      async staged() {
        const r = await readRsiFixed(d.io, 'counts.json');
        if (r.kind === 'missing') return [];
        const p = RsiCountsSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
        if (!p.success) throw new Error('counts invalid');
        return p.data.staged;
      },
    }),
    signals: makeSignalLookup({ io: d.io }),
    presets: makePresetSource({ payload: d.payload }),
    readySince: makeReadySinceRecovery(observer),
    analysis: makeAnalysisSource({
      io: d.io,
      rsiDir: d.rsiDir,
      ...makeAnalysisReadPorts({ home: d.home, rsiDir: d.rsiDir, classify, readState }),
    }),
  };
}

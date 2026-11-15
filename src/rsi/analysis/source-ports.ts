/**
 * `AnalysisSource` 里「装配处注入」的四个端口的**只读**生产适配器(装配块 A 段;`read.ts` 的 `AnalysisSourceDeps`):
 *  - `classify`:调用方给(`classifierFor` 的结果,与 shadow 观测同一分类器);
 *  - `payloadDrift`:登记表(`sync/ledger.json`)里有任一条目的**当前**内容与登记的 sha 不符(块体被手改 / 独占文件被改)= `drifted`;
 *    没有登记表 = `clean`(没有可漂移的东西);登记表不安全 / 不合规、条目的路径是链接 / 非普通文件 / 块损坏、读盘失败 = **抛错**(`run.ts` 映射为 `unavailable`,绝不落成 `clean`);条目对应内容已不在(missing)不算漂移;
 *  - `collectedThrough`:最近一次**完整成功**(`outcome = ok`)的 L0 采集 tick 的**开始时刻**(`last_tick.completed_at − duration_ms`;偏保守:取开始而不是结束,
 *    tick 期间新出现 / 在写的会话不算已覆盖);`state.json` 缺失 / 不合规 / 无 tick / 非 `ok`(含 `ok_partial`)= `null`(分析 `unavailable`);
 *  - `c4Bytes`:`canary.json` 的 treat 注入字节数(`c4BytesOfDoc`);文件缺失 / 不可读 / 不合规 = `null`。
 * 读失败的方向全部是 fail-closed;工厂创建不读盘。
 */
import { RsiStateSchema } from '../../contracts/rsi.js';
import { buildDiskSnapshot, readLedger } from '../../sync/snapshot.js';
import { OWNED_DIRS, currentOf, preflightEntry } from '../../sync/classify.js';
import { readCanaryDoc } from '../canary/permit-read.js';
import { c4BytesOfDoc, type AnalysisSourceDeps } from './read.js';

export type AnalysisReadPorts = Pick<
  AnalysisSourceDeps,
  'classify' | 'payloadDrift' | 'collectedThrough' | 'c4Bytes'
>;

export interface AnalysisReadPortsDeps {
  /** 已 realpath 的 HOME */
  home: string;
  /** 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录 */
  rsiDir: string;
  classify(projectKey: string): Promise<'P' | 'X' | 'U'>;
  /** `.state/rsi/state.json` 原文;不存在 = `null`;读不到抛错 */
  readState(): Promise<Uint8Array | null>;
}

class PortError extends Error {
  readonly code = 'RSI_ANALYSIS_PORT';
  constructor(what: string) {
    super(`analysis port: ${what}`);
  }
}

/** 纯函数:`state.json` 原文 → 采集覆盖时刻(见文件头注);任何不确定 = null */
export function collectedThroughOf(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  const p = RsiStateSchema.safeParse(raw);
  if (!p.success) return null;
  const t = p.data.last_tick;
  if (t === null || t.outcome !== 'ok') return null;
  const end = Date.parse(t.completed_at);
  if (!Number.isFinite(end)) return null;
  return new Date(Math.max(0, end - t.duration_ms)).toISOString();
}

export function makeAnalysisReadPorts(d: AnalysisReadPortsDeps): AnalysisReadPorts {
  return {
    classify: (k) => d.classify(k),
    async payloadDrift() {
      const lr = await readLedger(d.home);
      if (lr.state === 'absent') return 'clean';
      if (lr.state !== 'ok') throw new PortError('ledger_unreadable');
      const paths = new Set<string>();
      const blockIds: Record<string, string[]> = {};
      for (const e of lr.ledger.entries) {
        paths.add(e.path);
        if (e.block_id !== undefined) (blockIds[e.path] ??= []).push(e.block_id);
      }
      const snap = await buildDiskSnapshot({
        home: d.home,
        paths: [...paths],
        blockIds,
        ledgerPaths: lr.ledger.entries.map((e) => e.path),
        ownedDirs: OWNED_DIRS,
      });
      let drifted = false;
      for (const e of lr.ledger.entries) {
        const disk = snap.snapshot.entries[e.path];
        // 快照没有该路径(登记路径落在写入表外被跳过)= 查不到,不当成「没漂移」
        if (disk === undefined) throw new PortError('entry_not_probed');
        if (preflightEntry(disk, e.block_id) !== null) throw new PortError('entry_unsafe');
        const cur = currentOf(disk, e.block_id);
        if (cur.present && (cur.markerDrifted || cur.sha !== e.sha256)) drifted = true;
      }
      return drifted ? 'drifted' : 'clean';
    },
    async collectedThrough() {
      return collectedThroughOf(await d.readState());
    },
    async c4Bytes() {
      const r = await readCanaryDoc(d.rsiDir);
      return r.kind === 'ok' ? c4BytesOfDoc(r.value) : null;
    },
  };
}

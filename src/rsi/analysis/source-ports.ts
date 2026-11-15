/**
 * `AnalysisSource` 里「装配处注入」的四个端口的**只读**生产适配器(装配块 A 段;`read.ts` 的 `AnalysisSourceDeps`):
 *  - `classify`:调用方给(`classifierFor` 的结果,与 shadow 观测同一分类器);
 *  - `payloadDrift`:登记表(`sync/ledger.json`)里有任一条目的**当前**内容与登记的 sha 不符(块体被手改 / 独占文件被改)= `drifted`;
 *    **有登记而内容缺失一律 `drifted`**(目标文件已被删 / 托管块整体不在 / 只剩被删掉标记的块体:登记仍在、预期状态没消失,更彻底地移除不得反而消掉漂移事实);
 *    没有登记表 = `clean`,但这只表示「没有登记项发生漂移」,**不证明 payload 已装好 / 安装健康**(调用方不得据此外推);
 *    登记表不安全 / 不合规、条目的路径是链接 / 非普通文件 / 块损坏(含只有一个标记)、读盘失败 = **抛错**(`run.ts` 映射为 `unavailable`,绝不落成 `clean`);
 *  - `collectedThrough`:**`last_tick` 恰好为 `ok` 时**取其**开始时刻**(`completed_at − duration_ms`;不是「历史上最近一次成功 tick」;偏保守:取开始而不是结束,
 *    tick 期间新出现 / 在写的会话不算已覆盖);`state.json` 缺失 / 不合规 / 无 tick / 非 `ok`(含 `ok_partial`)/ `duration_ms` 大于完成时刻 = `null`(分析 `unavailable`)。
 *    **待核(本段不解决)**:「tick 开始时刻 = 采集覆盖水位」尚未证明(分页预算、积压、扫描快照边界、延迟发现可能造成缺口);
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
  const start = end - t.duration_ms;
  // 时长比完成时刻还大 = 不可信的时间组合:不合成 epoch 之类的「合法事实」,按不确定处理
  if (start < 0) return null;
  return new Date(start).toISOString();
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
        // 有登记而内容缺失(文件已删 / 托管块整体不在)= 漂移,不能因「没有可比的内容」被判成干净
        if (!cur.present || cur.markerDrifted || cur.sha !== e.sha256) drifted = true;
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

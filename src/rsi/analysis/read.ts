/**
 * 读取层:`AnalysisSource` 的生产适配器(只读;docs/contracts.md R21-6.4 / R21-6.6 / §21.24 W0-7)。
 *
 *  - 分组账:`readLedger`(坏账 / 不安全 → 抛错;不存在 = `[]`)。
 *  - 会话计数行 / 信号:逐行过 schema 的月文件扫描,**任一行不合规整体失败**(不用 `loadSignals`:它会因脱敏残留静默丢行,C1 / C3 会少计)。
 *  - 其余(归属分类、漂移、采集覆盖时刻、C4 字节)由装配处以端口注入。
 */
import * as path from 'node:path';
import type { CanaryDoc } from '../../contracts/rsi-personal.js';
import { SessionStatSchema } from '../../contracts/session-stat.js';
import { SignalSchema, type Signal } from '../../contracts/signal.js';
import type { IoContext } from '../../io/paths.js';
import { listMonthFiles, scanMonthFile } from '../../signals/store-scan.js';
import { treatText } from '../canary/canary-doc.js';
import { readLedger } from '../canary/ledger.js';
import type { StatItem } from '../canary/marker-view.js';
import type { AnalysisSource } from './run.js';

export interface AnalysisSourceDeps {
  io: IoContext;
  /** 已确认安全的 `.state/rsi` 目录 */
  rsiDir: string;
  classify(projectKey: string): Promise<'P' | 'X' | 'U'>;
  payloadDrift(): Promise<'clean' | 'drifted'>;
  collectedThrough(): Promise<string | null>;
  c4Bytes(): Promise<number | null>;
}

class ReadError extends Error {
  readonly code = 'RSI_ANALYSIS_READ';
  constructor(what: string) {
    super(`analysis read: ${what}`);
  }
}

const monthOf = (file: string): string => path.basename(file, '.jsonl');
const agentOf = (file: string): 'claude' | 'codex' | 'pi' => {
  const a = path.basename(path.dirname(file));
  if (a !== 'claude' && a !== 'codex' && a !== 'pi') throw new ReadError('unknown_agent_dir');
  return a;
};
const monthOfIso = (iso: string): string => `${iso.slice(0, 4)}${iso.slice(5, 7)}`;

/** treat 会话注入的字节数:标记定长,所以只取决于候选文档 */
export function c4BytesOfDoc(doc: Pick<CanaryDoc, 'content_sha12' | 'body'>): number {
  return Buffer.byteLength(treatText(`rsm_${'0'.repeat(16)}`, doc), 'utf8');
}

export function makeAnalysisSource(d: AnalysisSourceDeps): AnalysisSource {
  return {
    async ledger() {
      const r = await readLedger(d.rsiDir);
      if (r.kind === 'invalid') throw new ReadError('ledger_invalid');
      return r.kind === 'absent' ? [] : r.lines;
    },
    async stats(sinceIso) {
      const sinceMonth = monthOfIso(sinceIso);
      const sinceMs = Date.parse(sinceIso);
      const out: StatItem[] = [];
      for (const file of await listMonthFiles(d.io, 'sessions')) {
        if (monthOf(file) < sinceMonth) continue;
        const agent = agentOf(file);
        await scanMonthFile(file, (_raw, value) => {
          const p = SessionStatSchema.safeParse(value);
          if (!p.success) return false;
          if (Date.parse(p.data.ts) >= sinceMs) out.push({ agent, stat: p.data });
          return true;
        });
      }
      return out;
    },
    async signals(sinceIso) {
      const sinceMonth = monthOfIso(sinceIso);
      const sinceMs = Date.parse(sinceIso);
      const out: Signal[] = [];
      for (const file of await listMonthFiles(d.io, 'signals')) {
        if (monthOf(file) < sinceMonth) continue;
        agentOf(file);
        await scanMonthFile(file, (_raw, value) => {
          const p = SignalSchema.safeParse(value);
          if (!p.success) return false;
          if (Date.parse(p.data.ts) >= sinceMs) out.push(p.data);
          return true;
        });
      }
      return out;
    },
    classify: (k) => d.classify(k),
    payloadDrift: () => d.payloadDrift(),
    collectedThrough: () => d.collectedThrough(),
    c4Bytes: () => d.c4Bytes(),
  };
}

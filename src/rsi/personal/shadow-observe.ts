/**
 * shadow 计数的真实来源:会话计数库 `.state/sessions/` 与信号库 `.state/signals/` 的**只读**适配器(`ShadowObserver` 端口的生产实现)。
 *
 * 「有观测会话」(R21-1.7)在这里判定:
 *  ① 计数行存在 = reader 完整读完(计数行只为 `processed` 会话写;截断 / 解析失败的会话没有计数行——契约未给出更细的「完整」落盘证据,见汇报「问题」);
 *  ② 项目属「采集中」(`classify(project_key) === 'P'`:当前配置下的统一分类器,X / U 都不算;排除项目的会话与信号一律不计);
 *  ③ 会话若被随机分组:取回恰 1 个标记且该标记**能在分组账里找到**才计;取回 ≥ 2 个不同标记(多标记)不计;取回 0 个或缺键(未采集)的会话照计
 *     (没有标记就看不出它被随机过;这类会话在 shadow 阶段是常态)。分组账读不了 / 不合规而又需要它 → 抛错(事实不可得,不退化成「都计」)。
 * 窗口:`ts > sinceIso`(进入 shadow 之后开始的会话)。任何读取失败(月文件损坏、行不合 schema、信号库错误)都**抛错**,从不返回「空结果」冒充成功——
 * 调用方(`shadow-facts.ts`)把抛错映射为「事实不可得」(fail-closed)。
 */
import * as path from 'node:path';
import type { Redactor } from '../../contracts/redact.js';
import { SessionStatSchema, type SessionStat } from '../../contracts/session-stat.js';
import type { IoContext } from '../../io/paths.js';
import { loadSignals } from '../../reflect/load.js';
import { classifyMarkerRetrieval } from '../../signals/injection.js';
import { listMonthFiles, scanMonthFile } from '../../signals/store-scan.js';
import type { ShadowObservation, ShadowObserver } from './shadow-count.js';

export interface ShadowObserverDeps {
  io: IoContext;
  /** 当前配置下的归属分类:`P` = 采集中(`classifierFor(io, cfg)` 的结果) */
  classify(projectKey: string): Promise<'P' | 'X' | 'U'>;
  redactor: Pick<Redactor, 'pass2'>;
  /** 分组账里出现过的标记(assign 行 `marker` 非空);账读不了 → 抛错 */
  ledgerMarkers(): Promise<ReadonlySet<string>>;
}

const monthOf = (file: string): string => path.basename(file, '.jsonl');

async function loadStats(io: IoContext, sinceIso: string): Promise<SessionStat[]> {
  const sinceMonth = `${sinceIso.slice(0, 4)}${sinceIso.slice(5, 7)}`;
  const sinceMs = Date.parse(sinceIso);
  const out: SessionStat[] = [];
  const seen = new Set<string>();
  for (const file of await listMonthFiles(io, 'sessions')) {
    if (monthOf(file) < sinceMonth) continue;
    await scanMonthFile(file, (_raw, value) => {
      const p = SessionStatSchema.safeParse(value);
      if (!p.success) return false; // 行不合 schema:整个月文件按损坏处理(scanMonthFile 抛错),不跳过坏行
      if (seen.has(p.data.session_ref)) return true; // 同一 session_ref 至多一行;重复行只取第一行
      seen.add(p.data.session_ref);
      if (Date.parse(p.data.ts) > sinceMs) out.push(p.data);
      return true;
    });
  }
  return out;
}

export function makeShadowObserver(d: ShadowObserverDeps): ShadowObserver {
  return {
    async observe(sinceIso: string): Promise<ShadowObservation> {
      const stats = await loadStats(d.io, sinceIso);
      let markers: ReadonlySet<string> | undefined;
      const sessions: { session_ref: string; ts: string }[] = [];
      for (const s of stats) {
        if ((await d.classify(s.project_key)) !== 'P') continue;
        const kind = classifyMarkerRetrieval(s.rsi_markers);
        if (kind === 'multi_marker') continue;
        if (kind === 'ok') {
          markers ??= await d.ledgerMarkers();
          const m = s.rsi_markers?.[0];
          if (m === undefined || !markers.has(m)) continue;
        }
        sessions.push({ session_ref: s.session_ref, ts: s.ts });
      }
      const wanted = new Set(sessions.map((s) => s.session_ref));
      const loaded = await loadSignals(d.io, d.redactor, { since: sinceIso.slice(0, 10) });
      return {
        sessions,
        signals: loaded.signals.filter((s) => wanted.has(s.session_ref)),
      };
    },
  };
}

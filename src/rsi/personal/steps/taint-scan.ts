/**
 * 污染扫描器(C v1 §6 / v2 §7;**只读**,不写任何文件;纯编排,事实经 `TaintFactsPort`)。
 *
 * 事实源并集:暂存 run 的 `TAINTED` 标记 ∪ `purge-journal.json` 的 `taint_targets.runs`(**读 journal 只经 `services/purge-journal.ts` 的同一个解析函数**,装配层注入;
 * D3 扩 schema 后这里不会有私有副本读崩)。fail-closed:
 *  - journal `invalid` / `unreadable` → `unavailable`(不臆测任何候选干净);
 *  - 暂存区超限 → `unavailable{staging_too_large}`;存在无法处理的条目 / `rsi/` 不可信 → `unavailable{rsi_dir_untrusted}`(已有标记仍由 `resumeTaint` 路径处理,这里不据此放行任何候选);
 *  - 逐候选:来源缺失(`source` 为 null / undefined)→ `unknown{source_missing}`;run 目录不存在 → `unknown{run_dir_missing}`;标记读不出 → `unknown{mark_unreadable}`。
 *    unknown **不写 tainted 凭据**(无法断言被污染),不算 clean、不进 `tainted`。
 * 顺序:journal 命中的 run 先判 tainted(purge 的目的就是删掉证据,目录已被清走也属污染来源),再看标记与目录。
 */
import type { BothRound } from '../stage/round.js';
import type {
  TaintCandidate,
  TaintScanResult,
  TaintScanner,
  TaintUnknownWhy,
} from '../stage/taint-types.js';
import type { TaintFactsPort } from './steps-types.js';

export function createTaintScanner(facts: TaintFactsPort): TaintScanner {
  return {
    async scan(_round: BothRound, cands: readonly TaintCandidate[]): Promise<TaintScanResult> {
      const bound = await facts.stagingBound();
      if (bound === 'too_large') return { kind: 'unavailable', why: 'staging_too_large' };
      if (bound !== 'ok') return { kind: 'unavailable', why: 'rsi_dir_untrusted' };
      const j = await facts.journal();
      if (j.kind === 'invalid') return { kind: 'unavailable', why: 'journal_invalid' };
      if (j.kind === 'unreadable') return { kind: 'unavailable', why: 'journal_unreadable' };
      const targets = new Set(j.kind === 'ok' ? j.runs : []);
      const tainted: TaintCandidate[] = [];
      const unknown: { id: string; why: TaintUnknownWhy }[] = [];
      for (const c of cands) {
        const s = c.source;
        if (s === null || s === undefined) {
          unknown.push({ id: c.id, why: 'source_missing' });
          continue;
        }
        if (targets.has(s.run_id)) {
          tainted.push(c);
          continue;
        }
        const st = await facts.runState(s.run_id);
        if (st === 'tainted') tainted.push(c);
        else if (st === 'missing') unknown.push({ id: c.id, why: 'run_dir_missing' });
        else if (st === 'unreadable') unknown.push({ id: c.id, why: 'mark_unreadable' });
        // 'clean':来源 run 在、无标记、不在 journal 目标里
      }
      return { kind: 'ok', tainted, unknown };
    },
  };
}

/**
 * hint `--canary` 的执行部分(docs/contracts.md R21-6.2 / R21-6.3 / R21-6.4 / R21-6.11、§21.24 W0-3):把 {@link decideCanary} 的决定落成「分组账一行 + 输出文本」。
 * 返回 `''` = 本部分不输出(计数行由 hint 自己的原有规则独立判定,与本函数无关)。**从不抛错**(任何失败 = 不输出)。
 *
 * 顺序与不变量:
 *  - **未落账不注入**(第 8 行):第 6 / 7 行与探针行的输出文本只在账行 `appendFileSynced`(`O_APPEND` + `fsync`)成功返回之后才交给调用方;追加失败 → `''`。
 *    预算检查(`over()`)只在第一次写之前做:落账之后不再因超预算丢弃输出(否则会出现「有账行无输出」)。
 *  - **探针**:先取标记(随机源失败 → 不消费票、不落账),再占票、落账、输出仅含标记的一行;每个崩溃点之后都不超发、不重复授予。
 *  - **随机**(第 5 行):随机源抛错或给出 [0,1) 之外的值 → 账行 `excluded` / `rng_error`(`marker=null`、`p=0`),不输出;treat 概率为 `p`(`u < p`)。
 *  - **第 4 / 4a 行**:一行 `arm=excluded` + 原因码,不输出。第 3 行(无合法候选)不写任何账行。
 */
import type { CanaryDoc, RsiCanaryLedgerLine } from '../../contracts/rsi-personal.js';
import type { IoContext } from '../../io/paths.js';
import { controlText, markerLine, treatText } from './canary-doc.js';
import { decideCanary, type CanaryDecision, type DecideInput } from './canary-decide.js';
import { CANARY_HINT_VERSION, NO_BACKGROUND_FP, ledgerAt, markerFromBytes } from './files.js';
import { appendLedgerLine } from './ledger.js';
import { consumeProbeTicket } from './probe-ticket.js';

export interface CanaryRunEnv extends DecideInput {
  io: IoContext;
  /** 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录 */
  rsiDir: string;
  now: () => Date;
  /** [0, 1) 的均匀随机数;注入以便测试(失败 = 抛错或越界) */
  random: () => number;
  /** n 个随机字节(标记用 8 个) */
  randomBytes: (n: number) => Uint8Array;
  /** 预算已用尽(只在第一次写之前检查) */
  over: () => boolean;
}

type Draw = { ok: true; arm: 'treat' | 'control'; marker: string } | { ok: false };

function draw(env: CanaryRunEnv, p: number): Draw {
  try {
    const u = env.random();
    if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u >= 1) return { ok: false };
    const marker = markerFromBytes(env.randomBytes(8));
    return { ok: true, arm: u < p ? 'treat' : 'control', marker };
  } catch {
    return { ok: false };
  }
}

function assignLine(
  env: CanaryRunEnv,
  f: {
    marker: string | null;
    candidate_id: string | null;
    arm: 'treat' | 'control' | 'excluded';
    reason: Extract<RsiCanaryLedgerLine, { kind: 'assign' }>['reason'];
    p: number;
    doc: CanaryDoc | null;
    policyFp: string;
    /** 探针行专用(W0-18):占到的票的代号与票号;其余行 `null` */
    probe?: { generation: number; ticket: number };
  },
): RsiCanaryLedgerLine {
  return {
    kind: 'assign',
    at: ledgerAt(env.now()),
    agent: env.agent as 'claude' | 'pi',
    marker: f.marker,
    candidate_id: f.candidate_id,
    arm: f.arm,
    reason: f.reason,
    p: f.p,
    background_fp: f.doc?.background_fp ?? NO_BACKGROUND_FP,
    background_fp_ex: f.doc?.background_fp_ex ?? NO_BACKGROUND_FP,
    policy_fp: f.policyFp,
    case_set_sha256: null,
    // W0-18:treat / control 行抄 canary.json 的 overlaps_preset;探针行(doc = null)与候选无关,恒 false
    overlaps_preset: f.doc?.overlaps_preset ?? false,
    hint_version: CANARY_HINT_VERSION,
    probe_generation: f.probe?.generation ?? null,
    probe_ticket: f.probe?.ticket ?? null,
  };
}

async function execute(env: CanaryRunEnv, d: CanaryDecision): Promise<string> {
  switch (d.kind) {
    case 'none':
      return '';
    case 'probe': {
      // 先取标记:失败 = 不消费票、不落账(探针行必须带非空 marker)
      let marker: string;
      try {
        marker = markerFromBytes(env.randomBytes(8));
      } catch {
        return '';
      }
      if (env.over()) return '';
      const grant = await consumeProbeTicket(env.io, env.rsiDir, env.agent, d.entry);
      if (grant === null) return '';
      await appendLedgerLine(
        env.io,
        env.rsiDir,
        assignLine(env, {
          marker,
          candidate_id: null,
          arm: 'excluded',
          reason: 'admission_probe',
          p: 0,
          doc: null,
          policyFp: env.policyFp,
          // 同一 generation 与 i:取自占到的票(W0-18),不是另算
          probe: { generation: grant.generation, ticket: grant.index },
        }),
      );
      return `${markerLine(marker)}\n`;
    }
    case 'excluded': {
      if (env.over()) return '';
      await appendLedgerLine(
        env.io,
        env.rsiDir,
        assignLine(env, {
          marker: null,
          candidate_id: d.doc.candidate_id,
          arm: 'excluded',
          reason: d.reason,
          p: 0,
          doc: d.doc,
          policyFp: env.policyFp,
        }),
      );
      return '';
    }
    case 'randomize': {
      if (env.over()) return '';
      const r = draw(env, d.p);
      if (!r.ok) {
        await appendLedgerLine(
          env.io,
          env.rsiDir,
          assignLine(env, {
            marker: null,
            candidate_id: d.doc.candidate_id,
            arm: 'excluded',
            reason: 'rng_error',
            p: 0,
            doc: d.doc,
            policyFp: env.policyFp,
          }),
        );
        return '';
      }
      // 第 6 / 7 行:账行 O_APPEND + fsync 成功之后才输出;追加抛错 → 外层 catch → ''(第 8 行)
      await appendLedgerLine(
        env.io,
        env.rsiDir,
        assignLine(env, {
          marker: r.marker,
          candidate_id: d.doc.candidate_id,
          arm: r.arm,
          reason: null,
          p: d.p,
          doc: d.doc,
          policyFp: d.doc.policy_fp,
        }),
      );
      return r.arm === 'treat' ? treatText(r.marker, d.doc) : controlText(r.marker);
    }
  }
}

export async function runCanaryPart(env: CanaryRunEnv): Promise<string> {
  try {
    return await execute(env, await decideCanary(env));
  } catch {
    return '';
  }
}

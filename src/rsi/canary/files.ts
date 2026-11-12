/**
 * 灰度相关文件的名字、常量与小工具(docs/contracts.md R21-6.4 / R21-6.10、§21.24 W0-3)。
 * 全部位于 `.state/rsi/` 之下:`canary.json`、`canary-admission.json`、`AUTO_PAUSE`、`canary-ledger.jsonl`、`canary-probe/<agent>/<generation>-<i>.used`。
 * 纯常量与纯函数,无 I/O(hint 的闭包也会 import 它,保持轻量)。
 */
import { createHash } from 'node:crypto';
import type { RsiRevocationLine } from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';

export const CANARY_FILES = Object.freeze({
  canary: 'canary.json',
  admission: 'canary-admission.json',
  pause: 'AUTO_PAUSE',
  ledger: 'canary-ledger.jsonl',
  probeDir: 'canary-probe',
} as const);

/**
 * 分组账行的 `hint_version`:本块实现的 hint `--canary` 协议版本。契约只要求非负整数、没有给出取值表,故由实现自定;
 * 改变 `--canary` 的行为(输出形状、判定顺序)时必须加一(列入汇报「问题」,请契约确认取值规则)。
 */
export const CANARY_HINT_VERSION = 1;

/** 探针行没有候选,也读不到登记表(R21-6.10 的读集合不含它):`background_fp` / `background_fp_ex` 取 W0-7 的「无记录」全零常量 */
export const NO_BACKGROUND_FP = '0'.repeat(16);

/** 分组账一行的字节上限(含换行):远小于一个文件系统块,让一行落成一次底层 `write`(保证边界见 `safe-fs.appendFileSynced` 的注释) */
export const LEDGER_LINE_MAX_BYTES = 2048;

/** 分组账 `at` 只到秒(R21-6.4):`2026-11-10T12:00:00Z` */
export function ledgerAt(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/** 探针票占用文件名:`<generation>-<i>.used`(i 从 1 起) */
export function probeTicketName(generation: number, i: number): string {
  return `${generation}-${i}.used`;
}

/** `content_sha12` = `content_sha256` 前 12 位(R21-6.3 的「候选内容哈希前 12 位」) */
export const sha12Of = (contentSha256: string): string => contentSha256.slice(0, 12);

/** 随机会话标记(R21-6.3):`rsm_` + 16 位十六进制,取自 8 个随机字节 */
export function markerFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 8) throw new RangeError('随机标记需要恰好 8 个字节');
  return `rsm_${Buffer.from(bytes).toString('hex')}`;
}

/**
 * 撤销凭据行的 `revocation_ref`:该行 sha256 前 16 位(R21-6.4)。与 W3 对账证据 `revocation:<16 位>` 用同一算法
 * (`sha256(canonicalJson(行))` 前 16 位),所以同一凭据在两处得同一个值。
 */
export function revocationRefOf(line: RsiRevocationLine): string {
  return createHash('sha256').update(canonicalJson(line), 'utf8').digest('hex').slice(0, 16);
}

/**
 * `canary.json` 的写入方(docs/contracts.md R21-6.10、R21-9.5「对账先于授予」、R21-10.1、M13-4)。**worker 持 `rsi/lock` 与 `personal/lock` 写,0600**,
 * 经 `writeRsiFileAtomic`(临时文件 + rename)。三个入口:
 *  - {@link grantCanary}:授予影响(写一份「注入这个候选」的缓存)。**两把锁都要持**;在锁内依次:① 重读撤销凭据(读不到 → 拒绝;候选被列出 → 拒绝);
 *    ② 重读权威记录并核对该候选确在 `canary`、`content_sha256` 一致、且**没有别的候选占用评估名额**(M13-4,名额检查在锁内、按权威记录现算);
 *    ③ 跨字段语义校验({@link canaryDocProblem},与 hint 读侧同一份);④ `generation` = 现有文件的代数 + 1(现有文件读不到 / 不合规 → 从 1 起:覆盖它是安全方向),
 *    `revocation_gen` = 写入时撤销凭据的行数;⑤ 写。任何一步不成立 → 不写,返回拒绝码。
 *  - {@link muteCanary}:`AUTO_PAUSE` / 熔断(R21-10.1)——置为不注入(`agents_inject = []`、`p_by_agent = {}`),`generation + 1`。只减少影响,只需 `rsi/lock`。
 *  - {@link removeCanary}:撤销路径清理(R21-9.5):删文件。只需 `rsi/lock`。**生产里该调用必须发生在撤销凭据落盘之后**(凭据单独即可让 hint 停,清理只是收口)。
 */
import {
  CanaryDocSchema,
  type CanaryDoc,
  type PersonalLifecycleRecord,
  type RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import { RsiLockError } from '../lock-error.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import type { AuthoritativeStore, RevocationReader } from '../personal/candidate-ports.js';
import { evaluationSlotOccupied } from '../personal/transition-table.js';
import { removeRsiFile, writeRsiFileAtomic, type HeldLock } from './atomic-write.js';
import { canaryDocProblem } from './canary-doc.js';
import { CANARY_FILES, sha12Of } from './files.js';
import { readCanaryDoc } from './permit-read.js';

export interface GrantInput {
  candidate_id: string;
  content_sha256: string;
  p_by_agent: CanaryDoc['p_by_agent'];
  agents_inject: CanaryDoc['agents_inject'];
  background_fp: string;
  background_fp_ex: string;
  policy_fp: string;
}

export interface CanaryWriterDeps {
  io: IoContext;
  rsiDir: string;
  locks: { rsi: HeldLock; personal: HeldLock };
  revocations: RevocationReader;
  store: Pick<AuthoritativeStore, 'readAll'>;
  /**
   * 注入正文的**权威来源**(装配处从私有仓库里该候选的原子文件渲染;调用方不能自带正文——否则「声明的哈希」与「实际输出的正文」没有绑定)。
   * 在两把锁内、核对完权威记录之后调用;返回 `null` 或抛错 = 拿不到 → 拒绝授予。
   */
  bodyOf(rec: PersonalLifecycleRecord): Promise<string | null>;
}

export type GrantRefusal =
  | 'revocations_invalid'
  | 'revoked'
  | 'repo_unreadable'
  | 'candidate_not_canary'
  | 'content_changed'
  | 'slot_occupied'
  | 'body_unavailable'
  | `doc_invalid:${string}`;

export type GrantResult =
  { kind: 'written'; doc: CanaryDoc } | { kind: 'refused'; reason: GrantRefusal };

const listed = (lines: readonly RsiRevocationLine[], id: string, sha: string): boolean =>
  lines.some((l) => l.candidate_id === id && l.content_sha256 === sha);

export async function grantCanary(d: CanaryWriterDeps, g: GrantInput): Promise<GrantResult> {
  await d.locks.rsi.assertHeld();
  await d.locks.personal.assertHeld();
  // ① 对账先于授予:持锁重读撤销凭据
  const rv = await d.revocations.read();
  if (rv.kind !== 'ok') return { kind: 'refused', reason: 'revocations_invalid' };
  if (listed(rv.lines, g.candidate_id, g.content_sha256)) {
    return { kind: 'refused', reason: 'revoked' };
  }
  // ② 权威记录:候选确在 canary、内容未变、名额没有被别的候选占用(M13-4)
  const all = await d.store.readAll();
  if (all.kind !== 'ok') return { kind: 'refused', reason: 'repo_unreadable' };
  const rec: PersonalLifecycleRecord | undefined = all.value.find((r) => r.id === g.candidate_id);
  if (rec === undefined || rec.lifecycle !== 'canary') {
    return { kind: 'refused', reason: 'candidate_not_canary' };
  }
  if (rec.content_sha256 !== g.content_sha256)
    return { kind: 'refused', reason: 'content_changed' };
  if (evaluationSlotOccupied(all.value.filter((r) => r.id !== g.candidate_id))) {
    return { kind: 'refused', reason: 'slot_occupied' };
  }
  // 正文只取权威来源
  let body: string | null = null;
  try {
    body = await d.bodyOf(rec);
  } catch (e) {
    if (e instanceof RsiLockError) throw e;
  }
  if (body === null) return { kind: 'refused', reason: 'body_unavailable' };
  // ③ ④ 文档
  const prev = await readCanaryDoc(d.rsiDir);
  const generation = (prev.kind === 'ok' ? prev.value.generation : 0) + 1;
  const parsed = CanaryDocSchema.safeParse({
    candidate_id: g.candidate_id,
    content_sha256: g.content_sha256,
    body,
    content_sha12: sha12Of(g.content_sha256),
    p_by_agent: g.p_by_agent,
    agents_inject: [...g.agents_inject].sort(),
    background_fp: g.background_fp,
    background_fp_ex: g.background_fp_ex,
    policy_fp: g.policy_fp,
    revocation_gen: rv.lines.length,
    generation,
  });
  if (!parsed.success) return { kind: 'refused', reason: 'doc_invalid:schema' };
  const problem = canaryDocProblem(parsed.data);
  if (problem !== null) return { kind: 'refused', reason: `doc_invalid:${problem}` };
  // ⑤ 写(写点前复核两把锁)
  await writeRsiFileAtomic(d.io, d.rsiDir, CANARY_FILES.canary, canonicalJson(parsed.data), [
    d.locks.rsi,
    d.locks.personal,
  ]);
  return { kind: 'written', doc: parsed.data };
}

/** `AUTO_PAUSE` / 熔断:置为不注入(`generation + 1`)。无现有有效文件 = 无事可做。返回是否写了 */
export async function muteCanary(
  d: Pick<CanaryWriterDeps, 'io' | 'rsiDir'> & { locks: { rsi: HeldLock } },
): Promise<boolean> {
  await d.locks.rsi.assertHeld();
  const cur = await readCanaryDoc(d.rsiDir);
  if (cur.kind !== 'ok') return false;
  if (cur.value.agents_inject.length === 0) return false;
  const next = CanaryDocSchema.parse({
    ...cur.value,
    agents_inject: [],
    p_by_agent: {},
    generation: cur.value.generation + 1,
  });
  await writeRsiFileAtomic(d.io, d.rsiDir, CANARY_FILES.canary, canonicalJson(next), [d.locks.rsi]);
  return true;
}

/** 撤销路径清理:删除缓存文件(只收紧) */
export async function removeCanary(
  d: Pick<CanaryWriterDeps, 'io' | 'rsiDir'> & { locks: { rsi: HeldLock } },
): Promise<void> {
  await removeRsiFile(d.io, d.rsiDir, CANARY_FILES.canary, [d.locks.rsi]);
}

import { createHash } from 'node:crypto';
import { canonicalJson } from '../io/canonical-json.js';
import type { Proposal, SessionConfirmedJudgeRecord } from './proposal.js';

/**
 * `binding_sha256`(R20-18.15):让「写入之后有人(或工具)改了裁决枚举、厂商、规则哈希,或把记录搬到别的提案 / run 上」可被机械发现。
 * **不是签名**:同 UID 的进程可以连同哈希一起重写(R21-1.8)。写入时计算,读取 / 晋升 / CI 时重算,不等 → `*_CONFIRM_INVALID`。
 *
 * N4i-1:本文件需要 `canonicalJson`(`src/io/canonical-json.ts`,纯函数、无 IO、不 import 任何模块)。contracts 目录此前不 import io;
 * 这里是单向依赖且不引入任何 IO 能力,故接受;不在 contracts 里复制第二份规范化实现(两份会漂移)。
 */

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 去掉 undefined 值(zod 解析结果不含;手工构造的对象可能含),保证 canonicalJson 不因它抛错 */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Reflector = Proposal['reflector'];

/** 裁判侧:record = 本记录去掉 `confirmation.binding_sha256` 的全部字段 */
export function judgeBindingSha256(
  proposal: { id: string; reflector: Pick<Reflector, 'run_id' | 'input_digest'> },
  record: SessionConfirmedJudgeRecord,
): string {
  const { binding_sha256: _drop, ...confirmation } = record.confirmation;
  void _drop;
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposal_id: proposal.id,
      run_id: proposal.reflector.run_id,
      reflector_input_digest: proposal.reflector.input_digest ?? null,
      record: plain({ ...record, confirmation }),
    }),
  );
}

/** 反思器侧:record = `{reflector: 提案的 reflector 去掉 confirmed, confirmed: 去掉 binding_sha256 的 confirmed}` */
export function reflectorBindingSha256(proposal: {
  id: string;
  reflector: Reflector;
}): string | undefined {
  const { confirmed, ...reflector } = proposal.reflector;
  if (confirmed === undefined) return undefined;
  const { binding_sha256: _drop, ...rest } = confirmed;
  void _drop;
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposal_id: proposal.id,
      run_id: reflector.run_id,
      reflector_input_digest: reflector.input_digest ?? null,
      record: plain({ reflector, confirmed: rest }),
    }),
  );
}

/**
 * 写入前构造反思器侧绑定:调用方给出尚未带 `binding_sha256` 的 confirmed 内容(`confirmed` 之外的 reflector 字段取自提案)。
 */
export function reflectorBindingFor(
  proposal: { id: string; reflector: Reflector },
  confirmedWithoutBinding: Omit<NonNullable<Reflector['confirmed']>, 'binding_sha256'>,
): string {
  const probe = {
    id: proposal.id,
    reflector: {
      ...proposal.reflector,
      confirmed: { ...confirmedWithoutBinding, binding_sha256: '0'.repeat(64) },
    },
  };
  return reflectorBindingSha256(probe) as string;
}

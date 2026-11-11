/**
 * W1 ids.ts:idem_key / 候选 id / txn_id(纯函数;金向量由 `printf … | shasum -a 256` 在本机算出,写成字面量)。
 */
import { describe, expect, it } from 'vitest';
import { candidateId, idemKey, txnId } from '../../../src/rsi/personal/ids.js';

const BASE = {
  id: 'ra_0123456789ab',
  dim: 'lifecycle',
  from: 'proposed',
  to: 'shadow',
  evidence: 'gates_passed:ev1',
} as const;

describe('R21-4 idem_key = sha256(id, dim, agent, from, to, 证据指纹) 前 16 位', () => {
  it('金向量:固定输入得到固定的 16 位十六进制(编码 = JSON 数组,agent 缺省为 null)', () => {
    expect(idemKey(BASE)).toBe('6a7f261bc703539a');
    expect(idemKey(BASE)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('同一输入同一输出(确定性,崩溃重放得到同一个键;函数不含任何时钟参数)', () => {
    expect(idemKey({ ...BASE })).toBe(idemKey({ ...BASE }));
  });

  it('六个构成字段各改一个,键都变(负向:任何一项被丢掉都会让不同转移撞键)', () => {
    const k0 = idemKey(BASE);
    const variants = [
      { ...BASE, id: 'ra_0123456789ac' },
      { ...BASE, dim: 'deploy' as const },
      { ...BASE, agent: 'claude' },
      { ...BASE, from: 'shadow' },
      { ...BASE, to: 'rejected' },
      { ...BASE, evidence: 'gates_passed:ev2' },
    ];
    const keys = variants.map(idemKey);
    for (const k of keys) expect(k).not.toBe(k0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('字段边界无歧义:agent 为 null 与字面量字符串 "null" 不同;分隔符不会被借用', () => {
    expect(idemKey({ ...BASE, agent: 'null' })).not.toBe(idemKey(BASE));
    expect(idemKey({ ...BASE, from: 'a', to: 'b|c' })).not.toBe(
      idemKey({ ...BASE, from: 'a|b', to: 'c' }),
    );
  });
});

describe('W0-6 候选 id = ra_ + sha256("v1|run|proposal|content") 前 12 位', () => {
  it('金向量', () => {
    expect(candidateId('run-1', 'prop-1', 'aaaa')).toBe('ra_ba14d08adb85');
  });
  it('任一输入变,id 变;输出符合 RsiCandidateIdSchema 的形状', () => {
    const id = candidateId('run-1', 'prop-1', 'aaaa');
    expect(id).toMatch(/^ra_[0-9a-f]{12}$/);
    expect(candidateId('run-2', 'prop-1', 'aaaa')).not.toBe(id);
    expect(candidateId('run-1', 'prop-2', 'aaaa')).not.toBe(id);
    expect(candidateId('run-1', 'prop-1', 'aaab')).not.toBe(id);
  });
});

describe('规划稿 §2.4 txn_id = sha256(kind, candidate_ids, old_head, target_tree) 前 16 位', () => {
  const head = '1'.repeat(40);
  const tree = '2'.repeat(40);
  it('金向量;候选 id 先排序,与调用方顺序无关', () => {
    const a = txnId('rollback', ['ra_0123456789ab', 'ra_ba14d08adb85'], head, tree);
    expect(a).toBe('718712301dcd4c38');
    expect(txnId('rollback', ['ra_ba14d08adb85', 'ra_0123456789ab'], head, tree)).toBe(a);
  });
  it('kind / old_head / target_tree 各变一个,id 变;old_head 为 null 与字符串 "null" 不同', () => {
    const ids = ['ra_0123456789ab'];
    const base = txnId('transition', ids, head, tree);
    expect(txnId('rollback', ids, head, tree)).not.toBe(base);
    expect(txnId('transition', ids, '3'.repeat(40), tree)).not.toBe(base);
    expect(txnId('transition', ids, head, '4'.repeat(40))).not.toBe(base);
    expect(txnId('bootstrap', ids, null, tree)).not.toBe(txnId('bootstrap', ids, 'null', tree));
  });
});

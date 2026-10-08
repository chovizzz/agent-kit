import { describe, expect, it } from 'vitest';
import { SessionRefIdSchema } from '../../src/contracts/common.js';
import {
  projectKeyFor,
  provisionalSessionRef,
  sessionRefFor,
  sigIdFor,
} from '../../src/signals/ids.js';

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

describe('标识符哈希(contracts §9)', () => {
  it('形状符合 schema,且同输入同输出', () => {
    const s = sessionRefFor(SALT_A, '/x/y.jsonl');
    expect(SessionRefIdSchema.safeParse(s).success).toBe(true);
    expect(s).toBe(sessionRefFor(SALT_A, '/x/y.jsonl'));
    expect(projectKeyFor(SALT_A, '/x')).toMatch(/^p_[0-9a-f]{16}$/);
    expect(sigIdFor(SALT_A, s, 3)).toMatch(/^sig_[0-9a-f]{16}$/);
  });

  it('换盐则哈希全变(盐防字典反推);换路径/序号也变(正向对照:同盐同输入相等)', () => {
    const s = sessionRefFor(SALT_A, '/x/y.jsonl');
    expect(sessionRefFor(SALT_B, '/x/y.jsonl')).not.toBe(s);
    expect(sessionRefFor(SALT_A, '/x/z.jsonl')).not.toBe(s);
    expect(projectKeyFor(SALT_B, '/x')).not.toBe(projectKeyFor(SALT_A, '/x'));
    expect(sigIdFor(SALT_A, s, 1)).not.toBe(sigIdFor(SALT_A, s, 2));
    expect(sigIdFor(SALT_A, s, 1)).toBe(sigIdFor(SALT_A, s, 1));
  });

  it('域分隔:同一字符串作 session 与 project 输入不会撞值', () => {
    expect(sessionRefFor(SALT_A, '/p').slice(2)).not.toBe(projectKeyFor(SALT_A, '/p').slice(2));
  });

  it('临时 session_ref 无盐:与加盐值不同', () => {
    expect(provisionalSessionRef('/x/y.jsonl')).not.toBe(sessionRefFor(SALT_A, '/x/y.jsonl'));
  });
});

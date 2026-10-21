import { describe, expect, it } from 'vitest';
import { SAFE_PATH_RE as fromChecks } from '../../src/lifecycle/checks.js';
import { SAFE_PATH_RE as fromStage } from '../../src/reflect/stage.js';

describe('SAFE_PATH_RE 单一来源', () => {
  it('lifecycle/checks 与 reflect/stage 是同一个对象(任何一处复刻都会让它变红)', () => {
    expect(fromChecks).toBe(fromStage);
  });
  it('行为钉:小写字母数字开头,仅 a-z0-9/._-', () => {
    for (const ok of ['rules/a.md', 'a', '0x/y_z-1.txt']) expect(fromStage.test(ok), ok).toBe(true);
    for (const bad of ['', '/abs', '.hidden', '-x', 'A/b', 'a b', 'a\nb', 'a/é'])
      expect(fromStage.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

/**
 * D1b-1 架构钉子:`openPersonalRepo` 的生产调用方与模式收敛(S1 只用 `complete_only`;包装器写死 `read`;`bootstrap` 模式本期无生产调用方),
 * 守卫与 `refuseBootstrapRecovery` 开关已从 src 删净,放行版授权只在测试目录。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../../src/io/read-fs.js';
import { ROOT } from '../closure-util.js';

async function srcFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await srcFiles(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 文本里每个 `await openPersonalRepo(…);` 调用的 `mode: '<x>'`(取到第一个分号为止) */
export function openCallModes(text: string): string[] {
  const modes: string[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf('await openPersonalRepo(', from);
    if (i < 0) return modes;
    const end = text.indexOf(';', i);
    const m = /mode:\s*'(\w+)'/.exec(text.slice(i, end < 0 ? undefined : end));
    modes.push(m === null ? '?' : (m[1] as string));
    from = i + 1;
  }
}

describe('D1b-1 架构钉子', () => {
  it('openPersonalRepo 的生产调用方与模式:assemble-personal = [complete_only];commit.ts = [read, read];其余文件无调用', async () => {
    const found: Record<string, string[]> = {};
    for (const f of await srcFiles(path.join(ROOT, 'src'))) {
      const modes = openCallModes(await readText(f));
      if (modes.length > 0) found[path.relative(ROOT, f)] = modes;
    }
    expect(found).toEqual({
      'src/rsi/assemble-personal.ts': ['complete_only'],
      'src/rsi/personal/commit.ts': ['read', 'read'],
    });
  });

  it('正向对照:扫描器能报出 bootstrap / 缺 mode 的调用点', () => {
    expect(
      openCallModes(
        "await openPersonalRepo(d, l, { mode: 'bootstrap', auth });\nawait openPersonalRepo(d, l, x);",
      ),
    ).toEqual(['bootstrap', '?']);
  });

  it('守卫与开关已删净:src 里没有 refuseBootstrapRecovery / JournalKind / journalKind;放行版授权不在 src', async () => {
    for (const f of await srcFiles(path.join(ROOT, 'src'))) {
      const t = await readText(f);
      for (const banned of [
        'refuseBootstrapRecovery',
        'JournalKind',
        'journalKind',
        'TEST_BOOTSTRAP_AUTH',
      ]) {
        expect(t.includes(banned), `${path.relative(ROOT, f)}:${banned}`).toBe(false);
      }
    }
  });
});

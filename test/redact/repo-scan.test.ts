import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readDir, readText } from '../../src/io/read-fs.js';
import { chunkForCheck } from '../../src/redact/chunk.js';
import { createRedactor } from '../../src/redact/index.js';
import { REPO_ROOT } from '../helpers/tmp.js';

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) await walk(p, out);
    else if (e.isFile) out.push(p);
  }
}

/**
 * A10 的缩小版:本块自己的源码、测试、文档用自有扫描器全量扫描,必须零命中,**没有任何豁免**。
 * 这同时证明"仓库里不存在完整的假密钥字面量"(种子、测试里的秘密都是运行时拼装的)。
 */
describe('本块文件自扫描(A10 口径)', () => {
  it('src/redact、redact-cmd、test/redact、docs/redaction.md 零命中', async () => {
    const files: string[] = [];
    await walk(path.join(REPO_ROOT, 'src/redact'), files);
    await walk(path.join(REPO_ROOT, 'test/redact'), files);
    files.push(path.join(REPO_ROOT, 'src/commands/redact-cmd.ts'));
    files.push(path.join(REPO_ROOT, 'docs/redaction.md'));
    expect(files.length).toBeGreaterThan(15);

    const r = createRedactor({
      timeout_ms: 5000,
      allowed_url_hosts: ['github.com', 'raw.githubusercontent.com'],
    });
    const bad: string[] = [];
    for (const f of files) {
      const text = await readText(f);
      for (const c of chunkForCheck(text, 65536, 2048)) {
        const d = r.pass2Detail(c.text);
        for (const h of d.hits)
          bad.push(`${path.relative(REPO_ROOT, f)} ${h.rule}@${c.start + h.start}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('扫描器真的在工作(正向控制):同一份扫描逻辑对一个故意写进去的假秘密报命中', () => {
    const r = createRedactor({ timeout_ms: 5000 });
    const planted = `x = "sk-${'a1'.repeat(11)}"`;
    expect(r.pass2Detail(planted).clean).toBe(false);
  });
});

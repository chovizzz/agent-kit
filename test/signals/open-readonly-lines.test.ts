import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { openReadonlyLines, setOpenObserver } from '../../src/signals/open-readonly.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';

/** 清理项 4:open-readonly.ts 的注释必须与实现一致(实现是按字节读的 readLines,不是 readline)。 */
describe('openReadonlyLines:只认 \\n,与注释一致', () => {
  it('裸 \\r、U+2028 不切行;\\r\\n 去掉一个 \\r;每次打开都经观察者声明 O_RDONLY', async () => {
    const { ctx, dir } = await makeTempDir('ro-lines-');
    const p = path.join(dir, 'x.jsonl');
    await writeFile(ctx, p, 'a\rb c\r\nd\n');
    const seen: string[] = [];
    const prev = setOpenObserver((e) => seen.push(`${e.flags}:${e.purpose}`));
    try {
      const out: string[] = [];
      for await (const l of openReadonlyLines(p)) out.push(l);
      expect(out).toEqual(['a\rb c', 'd']);
      expect(seen).toEqual(['O_RDONLY:lines']);
    } finally {
      setOpenObserver(prev);
    }
  });

  it('源码注释不再声称「裸 \\r 会被 readline 当成行分隔」(过期说法)', async () => {
    const src = await readText(path.join(REPO_ROOT, 'src/signals/open-readonly.ts'));
    expect(src).not.toMatch(/readline\s*当成行分隔/);
    expect(src).toContain('不用 node:readline');
  });
});

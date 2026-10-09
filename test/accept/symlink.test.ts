import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as safe from '../../src/io/safe-fs.js';
import { guardRealHome, makeFx, putOutside, runScript } from './helpers.js';

guardRealHome();

// 验收时会用符号链接形式的临时目录(macOS 的 /var/folders -> /private/var/...)跑全套:
// 这里把 --root 与 KIT_TMP 都换成符号链接路径,脚本结论必须不变。
describe('符号链接形式的临时目录', () => {
  it('A1(确定性)与 A9(静态扫描)在 symlink 的 root / KIT_TMP 下结论不变', async () => {
    const fx = await makeFx('sym-');
    await fx.put('kit.toml', '[kit]\nname = "x"\n');
    await fx.put(
      'src/io/safe-fs.ts',
      "import * as fs from 'node:fs/promises';\nexport const w = fs.writeFile;\n",
    );
    await fx.put('stub-mode.txt', 'ok\n');
    const cli = await putOutside(
      fx,
      'stub-cli.mjs',
      `import * as fs from 'node:fs'; import * as path from 'node:path';
const a = process.argv.slice(2); const root = a[a.indexOf('--root') + 1];
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out', 'a.md'), 'x\\n');`,
    );
    const rootLink = path.join(fx.dir, 'root-link');
    const kitLink = path.join(fx.dir, 'kit-link');
    await safe.symlink(fx.ctx, fx.root, rootLink);
    await safe.symlink(fx.ctx, fx.kit, kitLink);
    const env = { KIT_TMP: kitLink };
    const a1 = runScript('a1-determinism.sh', ['--root', rootLink, '--cli', cli], env);
    expect(a1.status, a1.stdout).toBe(0);
    const a9 = runScript('a9-write-gate.sh', ['--root', rootLink, '--no-lint', '--no-vitest'], env);
    expect(a9.status, a9.stdout).toBe(0);
    // 同一套破坏在 symlink 形式下照样被抓住
    await fx.put('src/leak.ts', "import 'node:fs';\n");
    expect(
      runScript('a9-write-gate.sh', ['--root', rootLink, '--no-lint', '--no-vitest'], env).status,
    ).toBe(1);
  });
});

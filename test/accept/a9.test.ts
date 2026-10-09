import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import {
  callLib,
  guardRealHome,
  makeFx,
  putFakeVitest,
  REPO_ROOT,
  runScript,
  vitestJson,
} from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

interface Scan {
  scanned: number;
  allowedHits: number;
  violations: string[];
}

async function tree(files: Record<string, string>): Promise<Fx> {
  const fx = await makeFx('a9-');
  for (const [f, text] of Object.entries(files)) await fx.put(f, text);
  return fx;
}
const scan = (fx: Fx): Scan => callLib('a9.mjs', 'scanSources', [[fx.root]])[0] as Scan;

const SAFE_FS = "import * as fs from 'node:fs/promises';\nexport const w = fs.writeFile;\n";
const BASE = {
  'src/io/safe-fs.ts': SAFE_FS,
  'src/ok.ts': 'export const a = 1;\n',
  'cli.ts': 'export {};\n',
};

describe('A9 静态扫描', () => {
  it('只有 safe-fs 导入 fs => 无违规,且扫描器在放行文件里命中(非空跑)(正向控制)', async () => {
    const s = scan(await tree(BASE));
    expect(s.violations).toEqual([]);
    expect(s.allowedHits).toBe(1);
    expect(s.scanned).toBe(3);
  });

  it.each([
    ['静态导入', "import { writeFileSync } from 'node:fs';\n"],
    ['无前缀', "import * as fs from 'fs';\n"],
    ['fs/promises', "import { writeFile } from 'node:fs/promises';\n"],
    ['动态 import', "const m = await import('node:fs');\n"],
    ['require', "const fs = require('fs');\n"],
    ['副作用导入', "import 'node:fs';\n"],
    ['getBuiltinModule', "const fs = process.getBuiltinModule('fs');\n"],
  ])('越过唯一出口:%s => 违规', async (_n, line) => {
    const s = scan(await tree({ ...BASE, 'src/leak.ts': line }));
    expect(s.violations).toEqual(['src/leak.ts']);
  });

  it('adapters/ 与根 cli.ts 同样受限;io 目录下别的文件(paths.ts)也不能导入 fs', async () => {
    expect(
      scan(await tree({ ...BASE, 'adapters/x/y.ts': "import 'node:fs';\n" })).violations,
    ).toEqual(['adapters/x/y.ts']);
    expect(scan(await tree({ ...BASE, 'cli.ts': "import 'node:fs';\n" })).violations).toEqual([
      'cli.ts',
    ]);
    expect(
      scan(await tree({ ...BASE, 'src/io/paths.ts': "import 'node:fs';\n" })).violations,
    ).toEqual(['src/io/paths.ts']);
  });

  it('注释里提到 fs 不算(避免误报),字符串里的普通文字也不算', async () => {
    const s = scan(
      await tree({
        ...BASE,
        'src/doc.ts':
          "// import fs from 'node:fs'\n/* require('fs') */\nexport const t = 'we never import node:fs here';\n",
      }),
    );
    expect(s.violations).toEqual([]);
  });

  it('连放行文件里都没扫到 fs 导入 => 扫描器失明 => 1;没有源码 => 4', async () => {
    const blind = await tree({
      'src/ok.ts': 'export const a = 1;\n',
      'src/io/safe-fs.ts': 'export {};\n',
    });
    const r = runScript(
      'a9-write-gate.sh',
      ['--root', blind.root, '--no-lint', '--no-vitest'],
      blind.env(),
    );
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('扫描器失明');
    const empty = await tree({ 'README.md': 'x\n' });
    expect(
      runScript('a9-write-gate.sh', ['--root', empty.root, '--no-lint', '--no-vitest'], empty.env())
        .status,
    ).toBe(4);
  });
});

describe('A9 脚本', () => {
  it('真实仓库的静态扫描 => 无违规(正向控制:不是对着空树)', () => {
    const s = callLib('a9.mjs', 'scanSources', [[REPO_ROOT]])[0] as Scan;
    expect(s.violations).toEqual([]);
    expect(s.scanned).toBeGreaterThan(50);
    expect(s.allowedHits).toBeGreaterThanOrEqual(2);
  });

  it('违规源码 => 脚本退出 1', async () => {
    const fx = await tree({ ...BASE, 'src/leak.ts': "import 'node:fs';\n" });
    const r = runScript(
      'a9-write-gate.sh',
      ['--root', fx.root, '--no-lint', '--no-vitest'],
      fx.env(),
    );
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('src/leak.ts');
  });

  it('eslint 退出非 0 => 1;eslint 不存在 => 4;eslint 通过 => 该步 PASS', async () => {
    const fx = await tree(BASE);
    const bin = path.join(fx.root, 'node_modules', '.bin', 'eslint');
    await fx.put('node_modules/.bin/eslint', '#!/bin/sh\necho "1 error"\nexit 1\n', 0o755);
    const bad = runScript('a9-write-gate.sh', ['--root', fx.root, '--no-vitest'], fx.env());
    expect(bad.status, bad.stdout).toBe(1);
    expect(bad.stdout).toContain('eslint 退出 1');
    await fx.put('node_modules/.bin/eslint', '#!/bin/sh\nexit 0\n', 0o755);
    const good = runScript('a9-write-gate.sh', ['--root', fx.root, '--no-vitest'], fx.env());
    expect(good.status, good.stdout).toBe(0);
    expect(await readText(bin)).toContain('exit 0');
    const none = await tree(BASE);
    expect(
      runScript('a9-write-gate.sh', ['--root', none.root, '--no-vitest'], none.env()).status,
    ).toBe(4);
  });

  it('vitest:缺 test/io/safe-fs.test.ts => 1;齐全 => 0', async () => {
    const fx = await tree(BASE);
    await fx.put('test/lint/v.test.ts', '// x\n');
    const bin = await putFakeVitest(fx, vitestJson(fx.root, { 'test/lint/v.test.ts': ['a'] }));
    const r1 = runScript(
      'a9-write-gate.sh',
      ['--root', fx.root, '--no-lint', '--vitest-bin', bin],
      fx.env(),
    );
    expect(r1.status, r1.stdout).toBe(1);
    expect(r1.stdout).toContain('safe-fs.test.ts');
    await fx.put('test/io/safe-fs.test.ts', '// x\n');
    const bin2 = await putFakeVitest(
      fx,
      vitestJson(fx.root, {
        'test/lint/v.test.ts': ['a'],
        'test/io/safe-fs.test.ts': ['1', '2', '3', '4', '5', '6'],
      }),
    );
    const r2 = runScript(
      'a9-write-gate.sh',
      ['--root', fx.root, '--no-lint', '--vitest-bin', bin2],
      fx.env(),
    );
    expect(r2.status, r2.stdout).toBe(0);
  });
});

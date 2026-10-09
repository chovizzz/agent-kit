import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { readDir } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const FIXTURES = path.join(REPO_ROOT, 'test/fixtures/lint-violations');

/** 每个故意违规的 fixture 必须被拦,且命中的是预期的规则(不是别的无关错误)。 */
const EXPECTED: Readonly<Record<string, { rule: string; message: string }>> = {
  'child-process-import.ts': { rule: 'no-restricted-imports', message: 'child_process' },
  'constructor-chain.ts': { rule: 'no-restricted-syntax', message: '.constructor' },
  'process-shorthand.ts': { rule: 'no-restricted-syntax', message: '对象简写' },
  'create-require.ts': { rule: 'no-restricted-imports', message: 'node:module' },
  'dynamic-import-data-url.ts': { rule: 'no-restricted-syntax', message: 'data:' },
  'fs-dynamic-import-computed.ts': { rule: 'no-restricted-syntax', message: '字面量' },
  'fs-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '动态 import' },
  'fs-named-import-write.ts': { rule: 'no-restricted-imports', message: 'node:fs' },
  'fs-namespace-import.ts': { rule: 'no-restricted-imports', message: "'fs'" },
  'fs-promises-import.ts': { rule: 'no-restricted-imports', message: 'fs/promises' },
  'global-this-process.ts': { rule: 'no-restricted-syntax', message: 'globalThis' },
  'import-ops.ts': { rule: 'no-restricted-imports', message: 'ops/' },
  'inspector-import.ts': { rule: 'no-restricted-imports', message: 'node:inspector' },
  'network-fetch.ts': { rule: 'no-restricted-globals', message: 'fetch' },
  'os-homedir-import.ts': { rule: 'no-restricted-imports', message: 'node:os' },
  'process-alias.ts': { rule: 'no-restricted-syntax', message: 'process.<成员>' },
  'process-computed-key.ts': { rule: 'no-restricted-syntax', message: '动态键' },
  'process-cwd-read.ts': { rule: 'no-restricted-properties', message: 'process.cwd' },
  'process-destructure.ts': { rule: 'no-restricted-syntax', message: 'process.<成员>' },
  'process-env-read.ts': { rule: 'no-restricted-properties', message: 'process.env' },
  'process-get-builtin-module.ts': {
    rule: 'no-restricted-properties',
    message: 'getBuiltinModule',
  },
  'require-call.ts': { rule: 'no-restricted-syntax', message: 'require' },
};

const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
const eslintNormal = new ESLint({ cwd: REPO_ROOT });

describe('lint 反向对照:故意违规的 fixture 必须被拦住', () => {
  it('fixture 目录里的文件与期望表一一对应(不多不少,防止新增违规样本漏登记)', async () => {
    const files = (await readDir(FIXTURES)).filter((e) => e.isFile).map((e) => e.name);
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [file, exp] of Object.entries(EXPECTED)) {
    it(`${file} → ${exp.rule}`, async () => {
      const [res] = await eslint.lintFiles([path.join(FIXTURES, file)]);
      expect(res).toBeDefined();
      const hit = res!.messages.find(
        (m) => m.ruleId === exp.rule && m.message.includes(exp.message),
      );
      expect(hit, JSON.stringify(res!.messages.map((m) => [m.ruleId, m.message]))).toBeDefined();
      expect(res!.messages.some((m) => m.fatal)).toBe(false);
    });
  }

  it('正常 lint(ignore 生效)会跳过该目录:否则 pnpm run lint 会被反向对照打红', async () => {
    const dirty = await eslintNormal.isPathIgnored(path.join(FIXTURES, 'process-env-read.ts'));
    expect(dirty).toBe(true);
  });
});

describe('lint 正向对照:同样的代码放到被授权的文件里不报错', () => {
  const lintAs = async (code: string, rel: string) => {
    const [res] = await eslintNormal.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
    return res!.messages.filter((m) => m.ruleId?.startsWith('no-restricted'));
  };
  const FS = "import * as fs from 'node:fs';\nexport const x = fs.existsSync;\n";
  const OS = "import { homedir } from 'node:os';\nexport const h = homedir;\n";
  const CP = "import { spawnSync } from 'node:child_process';\nexport const s = spawnSync;\n";
  const ENV = "export const h = process.env['HOME'];\nexport const c = process.cwd();\n";

  it('fs 只在 safe-fs.ts / read-fs.ts 放行', async () => {
    expect(await lintAs(FS, 'src/io/safe-fs.ts')).toEqual([]);
    expect(await lintAs(FS, 'src/io/read-fs.ts')).toEqual([]);
    expect((await lintAs(FS, 'src/foo.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'src/io/paths.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'test/x.test.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'adapters/claude/x.ts')).length).toBeGreaterThan(0);
  });

  it('os / process.env / process.cwd 只在 paths.ts 放行', async () => {
    expect(await lintAs(OS, 'src/io/paths.ts')).toEqual([]);
    expect(await lintAs(ENV, 'src/io/paths.ts')).toEqual([]);
    expect((await lintAs(OS, 'src/io/safe-fs.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'src/io/exec.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'src/cli.ts')).length).toBeGreaterThan(0);
  });

  it('child_process 只在 exec.ts 放行', async () => {
    expect(await lintAs(CP, 'src/io/exec.ts')).toEqual([]);
    expect((await lintAs(CP, 'src/io/safe-fs.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(CP, 'src/commands/build.ts')).length).toBeGreaterThan(0);
  });

  it('process.stdout / process.argv / process.exitCode 这类无害用法不被误杀', async () => {
    const ok =
      'process.stdout.write("x");\nexport const a = process.argv;\nprocess.exitCode = 0;\n';
    expect(await lintAs(ok, 'src/foo.ts')).toEqual([]);
  });

  it('现有 src / adapters / cli.ts / test 的 lint 全绿(且确实检查了文件)', async () => {
    const results = await eslintNormal.lintFiles(['cli.ts', 'src', 'adapters', 'test']);
    expect(results.length).toBeGreaterThan(20);
    const errors = results.flatMap((r) =>
      r.messages
        .filter((m) => m.severity === 2)
        .map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`),
    );
    expect(errors).toEqual([]);
    // 全仓 lint 在机器忙时可能超过默认 20s;这里不是性能用例,给足时间。
  }, 120_000);
});

import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { hostEnvOf } from '../../src/commands/reflect.js';
import type { CommandContext } from '../../src/commands/types.js';
import { filterLlmEnv, LLM_ENV_ALLOW } from '../../src/io/llm-exec.js';
import {
  createIoContext,
  getRealHome,
  HOST_ENV_LC_RE,
  HOST_ENV_NAMES,
} from '../../src/io/paths.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const FAKE_HOME = '/nonexistent-fake-home/user';
const FAKE_REAL_HOME = '/nonexistent-fake-home/real';

/** 故意塞满「不该进子进程」的变量,同时含全部白名单名字。 */
const RICH: Record<string, string> = {
  PATH: '/fake/bin:/usr/bin',
  HOME: FAKE_HOME,
  USER: 'u',
  LOGNAME: 'u',
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  TMPDIR: '/fake/tmp',
  XDG_CONFIG_HOME: '/fake/cfg',
  XDG_DATA_HOME: '/fake/data',
  XDG_STATE_HOME: '/fake/state',
  XDG_CACHE_HOME: '/fake/cache',
  HTTP_PROXY: 'p',
  HTTPS_PROXY: 'p',
  ALL_PROXY: 'p',
  NO_PROXY: 'n',
  http_proxy: 'p',
  https_proxy: 'p',
  all_proxy: 'p',
  no_proxy: 'n',
  LC_ALL: 'C',
  LC_CTYPE: 'C',
  // 以下一律不得出现
  OPENAI_API_KEY: 'k',
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_BASE_URL: 'u',
  AWS_ACCESS_KEY_ID: 'a',
  AWS_SECRET_ACCESS_KEY: 'a',
  GITHUB_TOKEN: 't',
  CODEX_HOME: '/fake/codex',
  NODE_OPTIONS: '--x',
  LD_PRELOAD: '/x',
  TERM: 'xterm',
  SHELL: '/bin/sh',
  LC_lower: 'x',
  KIT_TMP: '/fake/kit',
};

const EXPECTED_KEYS = [
  'ALL_PROXY',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_PROXY',
  'PATH',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

const mk = (env: Record<string, string>) => createIoContext({ cwd: REPO_ROOT, env });

describe('IoContext.hostEnv:键集合快照', () => {
  it('只含白名单名字(含 LC_*),别的一个都不带', () => {
    const io = mk(RICH);
    expect(Object.keys(io.hostEnv).sort()).toEqual(EXPECTED_KEYS);
    for (const bad of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN',
      'CODEX_HOME',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'TERM',
      'SHELL',
      'LC_lower',
      'KIT_TMP',
    ]) {
      expect(bad in io.hostEnv, bad).toBe(false);
    }
  });

  it('值逐字来自注入的环境', () => {
    const io = mk(RICH);
    for (const k of EXPECTED_KEYS) expect(io.hostEnv[k], k).toBe(RICH[k]);
  });

  it('名字集合与 llm-exec 的 LLM_ENV_ALLOW 逐项相同(不得更宽,也不得更窄)', () => {
    expect([...HOST_ENV_NAMES].sort()).toEqual([...LLM_ENV_ALLOW].sort());
    expect(HOST_ENV_LC_RE.test('LC_ALL')).toBe(true);
    expect(HOST_ENV_LC_RE.test('LC_')).toBe(false);
    expect(HOST_ENV_LC_RE.test('XLC_ALL')).toBe(false);
  });

  it('是冻结的副本,改它不影响来源', () => {
    const src = { ...RICH };
    const io = mk(src);
    expect(Object.isFrozen(io.hostEnv)).toBe(true);
    src['LANG'] = 'changed';
    expect(io.hostEnv['LANG']).toBe('C.UTF-8');
  });

  it('PATH 缺省 /usr/bin:/bin(与 execPath 一致);HOME 缺省取 getRealHome(含 KIT_REAL_HOME_OVERRIDE)', () => {
    const io = mk({ KIT_REAL_HOME_OVERRIDE: FAKE_REAL_HOME });
    expect(io.hostEnv['PATH']).toBe('/usr/bin:/bin');
    expect(io.hostEnv['PATH']).toBe(io.execPath);
    expect(io.hostEnv['HOME']).toBe(FAKE_REAL_HOME);
    expect(io.hostEnv['HOME']).toBe(getRealHome({ KIT_REAL_HOME_OVERRIDE: FAKE_REAL_HOME }));
    expect(Object.keys(io.hostEnv).sort()).toEqual(['HOME', 'PATH']);
  });

  it('环境里有 HOME 就用它(与此前 hostEnvOf 的取值一致),KIT_REAL_HOME_OVERRIDE 不覆盖它', () => {
    const io = mk({ HOME: FAKE_HOME, KIT_REAL_HOME_OVERRIDE: FAKE_REAL_HOME });
    expect(io.hostEnv['HOME']).toBe(FAKE_HOME);
  });

  it('不传 env(真实 CLI 路径)时取受控读取:键都在白名单内,PATH / HOME 一定在', () => {
    const before = getRealHome();
    const io = createIoContext({ cwd: REPO_ROOT });
    for (const k of Object.keys(io.hostEnv)) {
      expect(HOST_ENV_NAMES.includes(k) || HOST_ENV_LC_RE.test(k), k).toBe(true);
    }
    expect(typeof io.hostEnv['PATH']).toBe('string');
    expect(path.isAbsolute(io.hostEnv['HOME'] ?? '')).toBe(true);
    expect(getRealHome()).toBe(before);
  });
});

describe('命令层的子进程环境来源', () => {
  const ctxOf = (io: ReturnType<typeof mk>, env?: Record<string, string>): CommandContext => ({
    argv: [],
    io,
    overlayPath: undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    ...(env !== undefined ? { env } : {}),
  });

  it('没注入 ctx.env:hostEnvOf = io.hostEnv;过 filterLlmEnv 后只剩白名单键 + NO_COLOR', () => {
    const io = mk(RICH);
    const src = hostEnvOf(ctxOf(io));
    expect(src).toEqual(io.hostEnv);
    const child = filterLlmEnv(src, [], io.execPath);
    expect(Object.keys(child).sort()).toEqual([...EXPECTED_KEYS, 'NO_COLOR'].sort());
    expect(child['NO_COLOR']).toBe('1');
    expect(child['HOME']).toBe(FAKE_HOME);
  });

  it('没注入 ctx.env 时 HOME 取错会被抓:override 下 HOME 必须是假真实 HOME', () => {
    const io = mk({ KIT_REAL_HOME_OVERRIDE: FAKE_REAL_HOME, PATH: '/fake/bin' });
    expect(hostEnvOf(ctxOf(io))['HOME']).toBe(FAKE_REAL_HOME);
    expect(hostEnvOf(ctxOf(io))['PATH']).toBe('/fake/bin');
  });

  it('注入了 ctx.env:行为同此前(整份展开 + PATH / HOME 缺省),子进程环境仍只有白名单键', () => {
    const io = mk({ KIT_REAL_HOME_OVERRIDE: FAKE_REAL_HOME });
    const ctx = ctxOf(io, { ...RICH });
    const source = hostEnvOf(ctx);
    expect(source['OPENAI_API_KEY']).toBe('k'); // 来源接口不脱敏,过滤在 filterLlmEnv
    const child = filterLlmEnv(source, [], io.execPath);
    expect('OPENAI_API_KEY' in child).toBe(false);
    expect(Object.keys(child).sort()).toEqual([...EXPECTED_KEYS, 'NO_COLOR'].sort());
    const bare = hostEnvOf(ctxOf(io, { LANG: 'C' }));
    expect(bare['PATH']).toBe(io.execPath);
    expect(bare['HOME']).toBe(getRealHome({ LANG: 'C' }));
  });

  it('API key 不经 hostEnv 进入(passEnv 要求的键在真实路径上取不到)', () => {
    const io = mk(RICH);
    const child = filterLlmEnv(hostEnvOf(ctxOf(io)), ['OPENAI_API_KEY'], io.execPath);
    expect('OPENAI_API_KEY' in child).toBe(false);
  });
});

describe('命令层不得绕过 hostEnv', () => {
  const SRC = path.join(REPO_ROOT, 'src');

  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    for (const e of await readDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory) await walk(p, out);
      else if (e.isFile && p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('src/commands 与 src/reflect 的代码行里没有 process.env / os.homedir(注释除外)', async () => {
    const cmdFiles = await walk(path.join(SRC, 'commands'));
    const reflectFiles = await walk(path.join(SRC, 'reflect'));
    // 正向控制组:两棵树各自扫到了关键文件
    expect(cmdFiles.some((f) => f.endsWith('commands/reflect.ts'))).toBe(true);
    expect(cmdFiles.some((f) => f.endsWith('commands/judge.ts'))).toBe(true);
    expect(reflectFiles.some((f) => f.endsWith('backends/cli-common.ts'))).toBe(true);
    const hits: string[] = [];
    for (const f of [...cmdFiles, ...reflectFiles]) {
      const lines = (await readText(f)).split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (/process\s*\.\s*env|process\[|homedir\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('EnvCommandContext 已移除:src/ 与 test/ 里不再出现(本文件除外)', async () => {
    const files = [...(await walk(SRC)), ...(await walk(path.join(REPO_ROOT, 'test')))].filter(
      (f) => !f.endsWith('llm-exec-host-env.test.ts'),
    );
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      if ((await readText(f)).includes('EnvCommandContext')) hits.push(f);
    }
    expect(hits).toEqual([]);
  });

  it('CommandContext.env 是正式字段', async () => {
    const text = await readText(path.join(SRC, 'commands/types.ts'));
    expect(text).toMatch(/export interface CommandContext \{[\s\S]*?\n {2}env\?:/);
  });

  it('lint:命令层文件读 process.env 被拦,同样的代码放进 paths.ts 不报错', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const code = "export const h = process.env['PATH'];\n";
    const lintAs = async (rel: string) => {
      const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
      expect(res, rel).toBeDefined();
      expect(res!.messages.some((m) => m.fatal), rel).toBe(false);
      return res!.messages.filter((m) => m.ruleId === 'no-restricted-properties');
    };
    expect((await lintAs('src/commands/reflect.ts')).length).toBeGreaterThan(0);
    expect((await lintAs('src/commands/judge.ts')).length).toBeGreaterThan(0);
    expect((await lintAs('src/reflect/backends/cli-common.ts')).length).toBeGreaterThan(0);
    expect(await lintAs('src/io/paths.ts')).toEqual([]);
  });
});

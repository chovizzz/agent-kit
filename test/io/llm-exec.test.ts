import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLM_STDOUT_MAX_BYTES,
  LlmExecDeniedError,
  LlmSpawnBudget,
  filterLlmEnv,
  llmCwd,
  runLlm,
} from '../../src/io/llm-exec.js';
import type { LlmRequest } from '../../src/io/llm-exec.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readText, realpath, statSync } from '../../src/io/read-fs.js';
import { chmod, mkdirp, mkdtemp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { REPO_ROOT, baseCtx, makeTempDir } from '../helpers/tmp.js';

const SYS_PATH = '/usr/bin:/bin';

/** 假 CLI 一律是 sh 脚本,放在临时目录里(仓库外或 KIT_TMP 内);不碰任何真实 LLM CLI、真实 HOME。 */
async function fixture(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const ctx: IoContext = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: SYS_PATH },
  });
  const fakeHome = path.join(dir, 'fake-home');
  await mkdirp(ctx, fakeHome);
  const bin = path.join(dir, 'bin');
  await mkdirp(ctx, bin);
  const install = async (name: string, body: string): Promise<string> => {
    const p = path.join(bin, name);
    await writeFile(ctx, p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await chmod(ctx, p, 0o755);
    return p;
  };
  const req = (file: string, extra: Partial<LlmRequest> = {}): LlmRequest => ({
    allowEgress: true,
    file,
    args: [],
    envSource: { PATH: `${bin}:${SYS_PATH}`, HOME: fakeHome, LANG: 'C' },
    timeoutMs: 10_000,
    budget: new LlmSpawnBudget(3),
    ...extra,
  });
  return { dir, ctx, fakeHome, bin, install, req };
}

/** 运行时拼装的假密钥(脚本里不出现密钥字面量)。 */
const fakeSecret = (tag: string) => ['fake', tag, 'value', '0123456789'].join('_');

const FIXED_JSON = '{"proposals":[]}';

describe('R0-7 llm-exec:出口开关', () => {
  it('缺 allowEgress / 非 true 的各种值 → IO_LLM_EGRESS_DENIED,且假二进制没有被执行、预算没被消耗', async () => {
    const f = await fixture('llm-egress-');
    const marker = path.join(f.dir, 'ran.marker');
    const bin = await f.install('claude', `echo ran > '${marker}'`);
    for (const v of [undefined, false, 'true', 1, null, {}]) {
      const r = f.req(bin);
      (r as { allowEgress?: unknown }).allowEgress = v;
      await expect(runLlm(f.ctx, r), String(v)).rejects.toMatchObject({
        code: 'IO_LLM_EGRESS_DENIED',
      });
      expect(r.budget.used).toBe(0);
    }
    expect(await exists(marker)).toBe(false);
    // 正向控制:传 true 就真的跑了(证明上面的"没跑"不是因为脚本本身坏了)
    const ok = f.req(bin);
    const res = await runLlm(f.ctx, ok);
    expect(res.status).toBe(0);
    expect(await exists(marker)).toBe(true);
  });
});

describe('R0-7 llm-exec:正常路径', () => {
  it('固定 JSON 输出被原样取回;stdin 到达;退出码与预算计数', async () => {
    const f = await fixture('llm-happy-');
    const bin = await f.install('codex', `cat >/dev/null; printf '%s' '${FIXED_JSON}'`);
    const r = f.req(bin, { input: 'prompt-body' });
    const res = await runLlm(f.ctx, r);
    expect(res).toMatchObject({
      status: 0,
      stdout: FIXED_JSON,
      timedOut: false,
      stdoutTruncated: false,
    });
    expect(res.spawnError).toBeUndefined();
    expect(r.budget.used).toBe(1);
    const echo = await f.install('pi', `cat`);
    const res2 = await runLlm(f.ctx, f.req(echo, { input: '提示 prompt' }));
    expect(res2.stdout).toBe('提示 prompt');
  });

  it('非零退出码与 stderr 被带回,stderr 只保留 4KiB', async () => {
    const f = await fixture('llm-fail-');
    const bin = await f.install('claude', `head -c 20000 /dev/zero | tr '\\0' 'e' >&2; exit 3`);
    const res = await runLlm(f.ctx, f.req(bin));
    expect(res.status).toBe(3);
    expect(res.stderr.length).toBe(4096);
  });

  it('裸名按 envSource.PATH 解析', async () => {
    const f = await fixture('llm-bare-');
    await f.install('pi', `printf bare-ok`);
    const res = await runLlm(f.ctx, f.req('pi'));
    expect(res.stdout).toBe('bare-ok');
  });
});

describe('R0-7 llm-exec:二进制白名单与解析', () => {
  it('白名单外的名字、相对路径、同名但不同目录的相对写法 → IO_LLM_BINARY_DENIED', async () => {
    const f = await fixture('llm-bin-');
    await f.install('claude', 'true');
    await f.install('evil', 'true');
    for (const file of [
      'sh',
      'bash',
      'node',
      'git',
      'evil',
      '/bin/sh',
      '/usr/bin/env',
      path.join(f.bin, 'evil'),
      './claude',
      'bin/claude',
      '../claude',
      'claude\0',
      '',
    ]) {
      await expect(runLlm(f.ctx, f.req(file)), JSON.stringify(file)).rejects.toMatchObject({
        code: 'IO_LLM_BINARY_DENIED',
      });
    }
  });

  it('名字叫 claude 却是指向 shell 名字二进制的符号链接 → 拒;指向正常名字的链接放行', async () => {
    const f = await fixture('llm-symlink-');
    const realDir = path.join(f.dir, 'real');
    await mkdirp(f.ctx, realDir);
    const fakeSh = path.join(realDir, 'sh');
    const fine = path.join(realDir, 'cli.js');
    for (const p of [fakeSh, fine]) {
      await writeFile(f.ctx, p, '#!/bin/sh\nprintf linked\n', { mode: 0o755 });
      await chmod(f.ctx, p, 0o755);
    }
    const bad = path.join(f.bin, 'claude');
    await symlink(f.ctx, fakeSh, bad);
    await expect(runLlm(f.ctx, f.req(bad))).rejects.toMatchObject({ code: 'IO_LLM_BINARY_DENIED' });
    // 正向控制:同样的链接结构,指向 cli.js(npm 全局安装的常见形态)放行
    const good = path.join(f.bin, 'codex');
    await symlink(f.ctx, fine, good);
    expect((await runLlm(f.ctx, f.req(good))).stdout).toBe('linked');
  });

  it('PATH 里的相对项/空项(= 当前目录)不会被用来找二进制', async () => {
    const f = await fixture('llm-relpath-');
    await f.install('claude', 'true');
    const r = f.req('claude', { envSource: { PATH: `:bin:./bin:${SYS_PATH}`, HOME: f.fakeHome } });
    await expect(runLlm(f.ctx, r)).rejects.toMatchObject({ code: 'IO_LLM_BINARY_DENIED' });
  });

  it('不可执行的文件被拒', async () => {
    const f = await fixture('llm-noexec-');
    const p = path.join(f.bin, 'claude');
    await writeFile(f.ctx, p, '#!/bin/sh\ntrue\n', { mode: 0o644 });
    await chmod(f.ctx, p, 0o644);
    await expect(runLlm(f.ctx, f.req(p))).rejects.toMatchObject({ code: 'IO_LLM_BINARY_DENIED' });
  });

  it('位于仓库内、且不在 KIT_TMP 内的二进制被拒(防仓库里埋假 claude);KIT_TMP 内的放行', async () => {
    // 无论 KIT_TMP 设在哪,都在 <repo>/.state/(gitignored)里造一个"仓库内的 claude"
    const repoCtx = baseCtx();
    const inRepoDir = await mkdtemp(
      repoCtx,
      path.join(repoCtx.stateDir, 'test-tmp'),
      'llm-inrepo-',
    );
    expect(path.relative(REPO_ROOT, await realpath(inRepoDir)).startsWith('..')).toBe(false);
    const p = path.join(inRepoDir, 'claude');
    await writeFile(repoCtx, p, '#!/bin/sh\ntrue\n', { mode: 0o755 });
    await chmod(repoCtx, p, 0o755);
    const other = await fixture('llm-otherroot-');
    await expect(runLlm(other.ctx, other.req(p))).rejects.toMatchObject({
      code: 'IO_LLM_BINARY_DENIED',
    });
    // 正向控制:同一个文件,当它位于 ctx.tmpDir 内时放行
    const same = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: inRepoDir, KIT_STATE_DIR: path.join(inRepoDir, 'state'), PATH: SYS_PATH },
    });
    const res = await runLlm(same, other.req(p));
    expect(res.status).toBe(0);
  });
});

describe('R0-7 llm-exec:不经 shell', () => {
  it('参数里的 shell 元字符原样传给进程,不会被解释', async () => {
    const f = await fixture('llm-noshell-');
    const marker = path.join(f.dir, 'pwned.marker');
    const bin = await f.install('claude', `printf '%s\\n' "$@"`);
    const args = [
      `; touch '${marker}'`,
      `$(touch '${marker}')`,
      `\`touch '${marker}'\``,
      '| tee x',
      '&& id',
      '*',
    ];
    const res = await runLlm(f.ctx, f.req(bin, { args }));
    expect(res.stdout.split('\n').slice(0, -1)).toEqual(args);
    expect(await exists(marker)).toBe(false);
  });

  it('参数含 NUL、非字符串、过多、过长 → IO_LLM_ARGS_DENIED', async () => {
    const f = await fixture('llm-args-');
    const bin = await f.install('claude', 'true');
    for (const args of [
      ['a\0b'],
      [1 as unknown as string],
      Array(65).fill('x'),
      ['x'.repeat(9000)],
    ]) {
      await expect(
        runLlm(f.ctx, f.req(bin, { args })),
        JSON.stringify(args).slice(0, 30),
      ).rejects.toMatchObject({
        code: 'IO_LLM_ARGS_DENIED',
      });
    }
    await expect(
      runLlm(f.ctx, f.req(bin, { input: 'x'.repeat(64 * 1024 + 1) })),
    ).rejects.toMatchObject({ code: 'IO_LLM_ARGS_DENIED' });
    // 正向控制:恰好 64KiB 通过
    await expect(
      runLlm(f.ctx, f.req(bin, { input: 'x'.repeat(64 * 1024) })),
    ).resolves.toMatchObject({
      status: 0,
    });
  });
});

describe('R0-7 llm-exec:env 名字白名单', () => {
  it('不继承 key/token/secret 类变量与加载器类变量;白名单内的变量到达;固定 NO_COLOR=1', async () => {
    const f = await fixture('llm-env-');
    const bin = await f.install('claude', '/usr/bin/env');
    const secrets = {
      ANTHROPIC_API_KEY: fakeSecret('a'),
      OPENAI_API_KEY: fakeSecret('o'),
      AWS_SECRET_ACCESS_KEY: fakeSecret('aws'),
      GITHUB_TOKEN: fakeSecret('gh'),
      MY_PASSWORD: fakeSecret('pw'),
      NODE_OPTIONS: '--require /tmp/evil.js',
      LD_PRELOAD: '/tmp/evil.so',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      CODEX_HOME: '/tmp/elsewhere',
      CLAUDE_CONFIG_DIR: '/tmp/elsewhere',
      TERM: 'xterm',
      FOO: 'bar',
    };
    const r = f.req(bin, {
      envSource: {
        ...secrets,
        PATH: `${f.bin}:${SYS_PATH}`,
        HOME: f.fakeHome,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
      },
    });
    const res = await runLlm(f.ctx, r);
    const env = Object.fromEntries(
      res.stdout
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    // 正向控制:白名单内的确实到了(否则下面的"没有"可能只是 env 打印坏了)
    expect(env['HOME']).toBe(f.fakeHome);
    expect(env['LANG']).toBe('C');
    expect(env['LC_ALL']).toBe('C');
    expect(env['TZ']).toBe('UTC');
    expect(env['NO_COLOR']).toBe('1');
    expect(env['PATH']).toContain(f.bin);
    for (const k of Object.keys(secrets)) expect(env[k], k).toBeUndefined();
    for (const v of Object.values(secrets)) expect(res.stdout).not.toContain(v);
  });

  it('passEnv 必须点名且形如 <NAME>_API_KEY;路由/加载器类名字被拒', async () => {
    const f = await fixture('llm-passenv-');
    const bin = await f.install('claude', '/usr/bin/env');
    const key = fakeSecret('pass');
    const envSource = {
      ANTHROPIC_API_KEY: key,
      OTHER_API_KEY: fakeSecret('other'),
      PATH: `${f.bin}:${SYS_PATH}`,
      HOME: f.fakeHome,
    };
    const res = await runLlm(f.ctx, f.req(bin, { envSource, passEnv: ['ANTHROPIC_API_KEY'] }));
    expect(res.stdout).toContain(`ANTHROPIC_API_KEY=${key}`);
    expect(res.stdout).not.toContain('OTHER_API_KEY'); // 没点名的不传
    for (const name of [
      'NODE_OPTIONS',
      'ANTHROPIC_BASE_URL',
      'CODEX_HOME',
      'LD_PRELOAD',
      'anthropic_api_key',
      'API_KEY',
      'FOO_API_KEY\n',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      await expect(
        runLlm(f.ctx, f.req(bin, { envSource, passEnv: [name] })),
        name,
      ).rejects.toMatchObject({ code: 'IO_LLM_ENV_DENIED' });
    }
  });

  it('filterLlmEnv 是纯函数:相对 HOME 被拒;含 NUL/超长的值被丢弃;不读 process.env', async () => {
    expect(() => filterLlmEnv({ HOME: 'relative/home' })).toThrow(LlmExecDeniedError);
    expect(filterLlmEnv({ LANG: 'a\0b', TZ: 'x'.repeat(5000) })).toEqual({ NO_COLOR: '1' });
    expect(filterLlmEnv({ HOME: '/h' }, [], '/usr/bin')).toEqual({
      HOME: '/h',
      PATH: '/usr/bin',
      NO_COLOR: '1',
    });
    const src = await readText(new URL('../../src/io/llm-exec.ts', import.meta.url).pathname);
    expect(src).not.toMatch(/process\.env/);
  });
});

describe('R0-7 llm-exec:固定 cwd', () => {
  it('子进程的 cwd 是 <state>/reflect/cwd/(调用方无法指定);目录权限 0700', async () => {
    const f = await fixture('llm-cwd-');
    const bin = await f.install('claude', '/bin/pwd -P');
    const res = await runLlm(f.ctx, f.req(bin));
    const want = await realpath(llmCwd(f.ctx));
    expect(res.stdout.trim()).toBe(want);
    expect(want.endsWith(path.join('reflect', 'cwd'))).toBe(true);
    expect(statSync(want).mode & 0o777).toBe(0o700);
    // LlmRequest 没有 cwd 字段:多传的 cwd 被忽略(类型上就不存在,运行时也不读)
    const sneaky = f.req(bin) as LlmRequest & { cwd?: string };
    sneaky.cwd = '/';
    expect((await runLlm(f.ctx, sneaky)).stdout.trim()).toBe(want);
  });

  it('运行前 cwd 非空 → IO_LLM_CWD_DENIED;子进程在 cwd 里留下的东西运行后被清掉并计数', async () => {
    const f = await fixture('llm-cwdclean-');
    const bin = await f.install('claude', `echo junk > ./CLAUDE.md; mkdir sub; echo x > sub/y`);
    const res = await runLlm(f.ctx, f.req(bin));
    expect(res.cwdResidue).toBe(2);
    expect(await exists(path.join(llmCwd(f.ctx), 'CLAUDE.md'))).toBe(false);
    // 下一次仍能运行(上一次的残留已清)
    expect((await runLlm(f.ctx, f.req(bin))).cwdResidue).toBe(2);
    // 手工放一个文件 → 拒绝,且不替用户删除
    await writeFile(f.ctx, path.join(llmCwd(f.ctx), 'AGENTS.md'), 'x');
    await expect(runLlm(f.ctx, f.req(bin))).rejects.toMatchObject({ code: 'IO_LLM_CWD_DENIED' });
    expect(await exists(path.join(llmCwd(f.ctx), 'AGENTS.md'))).toBe(true);
  });
});

describe('R0-7 llm-exec:超时 / stdout 上限 / 进程组', () => {
  it('超时 → timedOut=true,很快返回,且子进程的子进程也被杀', async () => {
    const f = await fixture('llm-timeout-');
    const pidFile = path.join(f.dir, 'child.pid');
    const bin = await f.install('claude', `/bin/sleep 30 &\necho $! > '${pidFile}'\nwait`);
    const t0 = Date.now();
    const res = await runLlm(f.ctx, f.req(bin, { timeoutMs: 1500 }));
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const pid = Number((await readText(pidFile)).trim());
    expect(pid).toBeGreaterThan(1);
    await expectDead(pid);
  });

  it('正常退出后遗留的孙进程也被收掉(不留孤儿)', async () => {
    const f = await fixture('llm-straggler-');
    const pidFile = path.join(f.dir, 'straggler.pid');
    const bin = await f.install(
      'claude',
      `/bin/sleep 30 >/dev/null 2>&1 &\necho $! > '${pidFile}'\nexit 0`,
    );
    const res = await runLlm(f.ctx, f.req(bin));
    expect(res.status).toBe(0);
    const pid = Number((await readText(pidFile)).trim());
    await expectDead(pid);
  });

  it('stdout 超过 32KiB → 进程被杀,stdoutTruncated=true,stdout 恰为前 32KiB', async () => {
    const f = await fixture('llm-cap-');
    const bin = await f.install('claude', `head -c 200000 /dev/zero | tr '\\0' 'a'; /bin/sleep 30`);
    const t0 = Date.now();
    const res = await runLlm(f.ctx, f.req(bin));
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stdout.length).toBe(LLM_STDOUT_MAX_BYTES);
    expect(Date.now() - t0).toBeLessThan(8000);
    // 正向控制:恰好 32KiB 不算截断
    const exact = await f.install('pi', `head -c ${LLM_STDOUT_MAX_BYTES} /dev/zero | tr '\\0' 'a'`);
    const ok = await runLlm(f.ctx, f.req(exact));
    expect(ok.stdoutTruncated).toBe(false);
    expect(ok.stdout.length).toBe(LLM_STDOUT_MAX_BYTES);
  });

  it('timeoutMs 非法(0、负数、小数、超过上限)→ IO_LLM_ARGS_DENIED', async () => {
    const f = await fixture('llm-tbad-');
    const bin = await f.install('claude', 'true');
    for (const timeoutMs of [0, -1, 1.5, 600_001, Number.NaN]) {
      await expect(
        runLlm(f.ctx, f.req(bin, { timeoutMs })),
        String(timeoutMs),
      ).rejects.toMatchObject({
        code: 'IO_LLM_ARGS_DENIED',
      });
    }
  });
});

describe('R0-7 llm-exec:spawn 次数计数', () => {
  it('预算为 2 时第 3 次抛 IO_LLM_SPAWN_LIMIT,且第 3 次没有真的 spawn', async () => {
    const f = await fixture('llm-budget-');
    const log = path.join(f.dir, 'spawns.log');
    const bin = await f.install('claude', `echo x >> '${log}'`);
    const budget = new LlmSpawnBudget(2);
    await runLlm(f.ctx, f.req(bin, { budget }));
    await runLlm(f.ctx, f.req(bin, { budget }));
    await expect(runLlm(f.ctx, f.req(bin, { budget }))).rejects.toMatchObject({
      code: 'IO_LLM_SPAWN_LIMIT',
    });
    expect(budget.used).toBe(2);
    expect((await readText(log)).trim().split('\n')).toHaveLength(2);
  });

  it('失败的 spawn(超时、非零退出)同样消耗预算', async () => {
    const f = await fixture('llm-budget-fail-');
    const bin = await f.install('claude', 'exit 9');
    const budget = new LlmSpawnBudget(1);
    expect((await runLlm(f.ctx, f.req(bin, { budget }))).status).toBe(9);
    await expect(runLlm(f.ctx, f.req(bin, { budget }))).rejects.toMatchObject({
      code: 'IO_LLM_SPAWN_LIMIT',
    });
  });

  it('被拒绝的请求(出口开关、白名单、参数)不消耗预算', async () => {
    const f = await fixture('llm-budget-deny-');
    const budget = new LlmSpawnBudget(1);
    await expect(runLlm(f.ctx, f.req('sh', { budget }))).rejects.toThrow(LlmExecDeniedError);
    expect(budget.used).toBe(0);
  });

  it('预算本身的取值受限:1..10 的整数', () => {
    for (const n of [0, -1, 1.5, 11, Number.NaN]) {
      expect(() => new LlmSpawnBudget(n), String(n)).toThrow(LlmExecDeniedError);
    }
    expect(new LlmSpawnBudget(10).max).toBe(10);
  });
});

async function expectDead(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`进程 ${pid} 仍然存活`);
}

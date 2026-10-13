import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JUDGE_HOP_CHAIN } from '../../../src/contracts/proposal.js';
import type { LlmBackend } from '../../../src/reflect/backend-iface.js';
import { CliBackend } from '../../../src/reflect/backends/cli-common.js';
import { CLAUDE_ARGS } from '../../../src/reflect/backends/cli-claude.js';
import { CODEX_ARGS } from '../../../src/reflect/backends/cli-codex.js';
import { PI_ARGS } from '../../../src/reflect/backends/cli-pi.js';
import { listCliArgSets } from '../../../src/reflect/backends/index.js';
import { chmod, mkdirp, mkdtemp, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { exists, lstat } from '../../../src/io/read-fs.js';
import { LLM_STDIN_MAX_BYTES } from '../../../src/io/llm-exec.js';
import { baseCtx, REPO_ROOT } from '../../helpers/tmp.js';
import {
  CLAUDE_BINDING,
  CODEX_BINDING,
  FIXED_JSON,
  PI_BINDING,
  REQ,
  SYS_PATH,
  fakeSecret,
  fixture,
} from './_fixture.js';

const CODEX_DISABLE_FEATURES = [
  'shell_tool',
  'unified_exec',
  'js_repl',
  'code_mode',
  'view_image',
  'multi_agent',
  'apps',
  'plugins',
  'memories',
] as const;
const CODEX_DISABLES = CODEX_DISABLE_FEATURES.flatMap((f) => ['--disable', f]);
const lines = (s: string | undefined) => (s ?? '').split('\n').slice(0, -1);
const bySlot = (list: readonly LlmBackend[], slot: string): LlmBackend => {
  const b = list.find((x) => x.slot === slot);
  if (b === undefined) throw new Error(`no slot ${slot}`);
  return b;
};

/** 每个适配器的 happy path:参数、stdin、输出;并给出参数集清单的静态断言。 */
describe('R3 适配器 happy path 与参数集', () => {
  const cases = [
    {
      name: 'claude',
      binding: CLAUDE_BINDING,
      vendor: 'anthropic',
      argv: [
        '-p',
        '--model',
        'claude-test-1',
        '--tools',
        '',
        '--strict-mcp-config',
        '--no-session-persistence',
      ],
    },
    {
      name: 'codex',
      binding: CODEX_BINDING,
      vendor: 'openai',
      argv: [
        'exec',
        '-m',
        'gpt-test-1',
        '-c',
        'model_provider="openai"',
        '-c',
        'mcp_servers={}',
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        ...CODEX_DISABLES,
      ],
    },
    {
      name: 'pi',
      binding: PI_BINDING,
      vendor: 'zhipu',
      argv: [
        '-p',
        '--no-session',
        '--no-context-files',
        '--no-skills',
        '--no-extensions',
        '--provider',
        'zai',
        '--model',
        'glm-test-1',
        '--no-tools',
      ],
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}:固定 JSON 取回;提示走 stdin;argv 精确`, async () => {
      const f = await fixture(`be-happy-${c.name}-`);
      const argv = f.rec('argv.txt');
      const stdin = f.rec('stdin.txt');
      await f.install(
        c.name,
        `printf '%s\\n' "$@" > '${argv}'; cat > '${stdin}'; printf '%s' '${FIXED_JSON}'`,
      );
      const be = bySlot(f.build({ backends: [c.binding] }), c.binding.slot);
      expect(be.vendor).toBe(c.vendor);
      const r = await be.complete({ ...REQ, system: 'SYS-MARK', user: 'USR-MARK' });
      expect(r).toEqual({ ok: true, text: FIXED_JSON });
      expect(await f.read(stdin)).toBe('SYS-MARK\n\nUSR-MARK\n');
      expect(f.budget.used).toBe(1);
      const got = lines(await f.read(argv));
      expect(got).toEqual(c.argv);
    });
  }

  it('claude 参数:显式 --model、空工具集、--strict-mcp-config、无会话落盘', () => {
    expect(CLAUDE_ARGS.build({ model: 'm' })).toEqual([
      '-p',
      '--model',
      'm',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]);
  });

  it('codex 参数:每次显式传 -m 与 model_provider(缺省显式写 openai)、空 MCP、只读沙箱', () => {
    const a = CODEX_ARGS.build({ model: 'm', provider: undefined });
    expect(a).toContain('-m');
    expect(a[a.indexOf('-m') + 1]).toBe('m');
    expect(a).toContain('model_provider="openai"');
    expect(a).toContain('mcp_servers={}');
    expect(a).not.toContain('mcp_servers="{}"'); // R6:带引号的写法在 codex 0.161 报错,防回退
    expect(a.some((x) => x.startsWith('mcp_servers=') && x.includes('"'))).toBe(false);
    expect(a.slice(-CODEX_DISABLES.length)).toEqual([...CODEX_DISABLES]);
    for (const f of CODEX_DISABLE_FEATURES) {
      expect(a[a.indexOf(f) - 1]).toBe('--disable');
    }
    expect(a[a.indexOf('-s') + 1]).toBe('read-only');
    expect(a).toContain('--skip-git-repo-check');
    expect(CODEX_ARGS.build({ model: 'm', provider: 'azure' })).toContain('model_provider="azure"');
  });

  it('pi 参数:显式 --provider/--model,四个 --no-* 隔离旗标', () => {
    const a = PI_ARGS.build({ model: 'm', provider: 'zai' });
    expect(a[a.indexOf('--provider') + 1]).toBe('zai');
    expect(a[a.indexOf('--model') + 1]).toBe('m');
    for (const f of ['--no-session', '--no-context-files', '--no-skills', '--no-extensions']) {
      expect(a).toContain(f);
    }
    expect(a).toContain('--no-tools'); // R6:取代 --tools read
    expect(a).not.toContain('--tools');
    expect(a).not.toContain('read');
  });

  it('三个参数集全部 verified:false,且逐项声明了核实状态(noTools 等至少一项 unresolved)', () => {
    const sets = listCliArgSets();
    expect(sets.map((s) => s.cli).sort()).toEqual(['claude', 'codex', 'pi']);
    for (const s of sets) {
      expect(s.verified).toBe(false);
      expect(s.basis.length).toBeGreaterThan(10);
      expect(Object.values(s.claims).some((v) => v === 'unresolved')).toBe(true);
    }
  });

  it('R6 claims 新值:noTools 三者 verified;codex 的 noMcp/noSession 为 not_met;未测项保持 unresolved', () => {
    for (const s of [CLAUDE_ARGS, CODEX_ARGS, PI_ARGS]) {
      expect(s.claims.noTools).toBe('verified');
      expect(s.claims.inputViaStdin).toBe('verified');
    }
    expect(CLAUDE_ARGS.claims.noSession).toBe('verified');
    expect(PI_ARGS.claims.noSession).toBe('verified');
    expect(CODEX_ARGS.claims.noMcp).toBe('not_met');
    expect(CODEX_ARGS.claims.noSession).toBe('not_met');
    for (const s of [CLAUDE_ARGS, CODEX_ARGS]) {
      expect(s.claims.noProjectContext).toBe('unresolved');
    }
    for (const s of [CLAUDE_ARGS, CODEX_ARGS, PI_ARGS]) {
      expect(s.claims.noProjectSettings).toBe('unresolved');
      expect(s.claims.noUserRouting).toBe('unresolved');
    }
  });

  it('claims 里每个 verified / not_met 项,basis 里有对应的 `<项>=<状态>` 说明与 R6 日期', () => {
    for (const s of listCliArgSets()) {
      expect(s.basis).toContain('2026-10-13');
      for (const [k, v] of Object.entries(s.claims)) {
        if (v === 'verified' || v === 'not_met') expect(s.basis).toContain(`${k}=${v}`);
      }
    }
  });

  it('globalWrites 清单:claude/codex 含 R6 记录的路径、pi 为空,且数组已冻结', () => {
    expect(CLAUDE_ARGS.globalWrites.some((w) => w.includes('~/.claude.json'))).toBe(true);
    for (const n of ['state_5', 'goals_1', 'queue_1', 'logs_2']) {
      expect(CODEX_ARGS.globalWrites.some((w) => w.includes(n))).toBe(true);
    }
    expect(PI_ARGS.globalWrites).toEqual([]);
    for (const s of listCliArgSets()) expect(Object.isFrozen(s.globalWrites)).toBe(true);
  });
});

describe('R3 输出与错误映射', () => {
  it('stdout 超过 maxOutputBytes → error(output_too_large);正向控制:不超时成功', async () => {
    const f = await fixture('be-outcap-');
    await f.install('claude', `cat >/dev/null; head -c 600 /dev/zero | tr '\\0' x`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect(await be.complete({ ...REQ, maxOutputBytes: 500 })).toEqual({
      ok: false,
      reason: 'error',
      detail: 'output_too_large',
    });
    const ok = await be.complete({ ...REQ, maxOutputBytes: 1000 });
    expect(ok.ok).toBe(true);
  });

  it('stdout 超过 32KiB 硬上限 → error(进程被杀)', async () => {
    const f = await fixture('be-hardcap-');
    await f.install('claude', `cat >/dev/null; head -c 70000 /dev/zero | tr '\\0' x`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect(await be.complete({ ...REQ, maxOutputBytes: 1_000_000 })).toMatchObject({
      ok: false,
      reason: 'error',
      detail: 'output_too_large',
    });
  });

  it('超时 → timeout,且整个进程组被杀(孙进程没有写出标记)', async () => {
    const f = await fixture('be-timeout-');
    const started = f.rec('started.marker');
    const late = f.rec('late.marker');
    await f.install(
      'claude',
      `echo up > '${started}'; ( sleep 4; echo late > '${late}' ) & cat >/dev/null; sleep 30`,
    );
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    const r = await be.complete({ ...REQ, timeoutMs: 2500 });
    expect(r).toEqual({ ok: false, reason: 'timeout', detail: 'timeout' });
    expect(await exists(started)).toBe(true); // 正向控制:脚本确实跑起来了
    await new Promise((res) => setTimeout(res, 4500));
    expect(await exists(late)).toBe(false);
  });

  it('非 0 退出 → error(exit_N),不回显 stderr 原文', async () => {
    const f = await fixture('be-exit-');
    const leak = ['leak', 'text', 'zz9'].join('_');
    await f.install('claude', `cat >/dev/null; echo ${leak} >&2; exit 3`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    const r = await be.complete(REQ);
    expect(r).toEqual({ ok: false, reason: 'error', detail: 'exit_3' });
    expect(JSON.stringify(r)).not.toContain(leak);
  });

  it('退出 0 但无输出 → error(empty_output)', async () => {
    const f = await fixture('be-empty-');
    await f.install('claude', `cat >/dev/null; true`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect(await be.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'empty_output' });
  });

  it('402/403/连接失败 → 原样 error,不写冷却,下一次照常真试', async () => {
    const f = await fixture('be-nocool-');
    const counter = f.rec('count.txt');
    for (const [text, detail] of [
      ['HTTP 402 payment required', 'http_402'],
      ['403 forbidden', 'http_403'],
      ['connect ECONNREFUSED upstream', 'connection_error'],
    ] as const) {
      await f.install(
        'claude',
        `cat >/dev/null; echo x >> '${counter}'; echo '${text}' >&2; exit 1`,
      );
      const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
      expect(await be.complete(REQ)).toEqual({ ok: false, reason: 'error', detail });
    }
    expect(lines(await f.read(counter)).length).toBe(3);
    expect(await exists(path.join(f.ctx.stateDir, 'llm-cooldown'))).toBe(false);
  });

  it('输入过大(>64KiB)与坏的请求参数:error,不 spawn、不消耗预算', async () => {
    const f = await fixture('be-badreq-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect(await be.complete({ ...REQ, user: 'x'.repeat(LLM_STDIN_MAX_BYTES + 1) })).toMatchObject({
      ok: false,
      reason: 'error',
      detail: 'input_too_large',
    });
    expect(await be.complete({ ...REQ, timeoutMs: 0 })).toMatchObject({ detail: 'bad_request' });
    expect(await be.complete({ ...REQ, maxOutputBytes: 0 })).toMatchObject({
      detail: 'bad_request',
    });
    expect(await exists(marker)).toBe(false);
    expect(f.budget.used).toBe(0);
  });
});

describe('R3 not_installed 与仓库内二进制', () => {
  it('PATH 里没有该二进制 → not_installed,不 spawn', async () => {
    const f = await fixture('be-notinst-');
    const be = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { envSource: { PATH: SYS_PATH, HOME: f.fakeHome } }),
      'codex',
    );
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_installed',
      detail: 'binary_not_found',
    });
    expect(f.budget.used).toBe(0);
  });

  it('仓库内的二进制被拒(经 runLlm 的 BINARY_DENIED → not_installed),且没有被执行', async () => {
    const f = await fixture('be-inrepo-');
    const repoCtx = baseCtx();
    const inRepoDir = await mkdtemp(repoCtx, path.join(repoCtx.stateDir, 'test-tmp'), 'be-inrepo-');
    const marker = path.join(inRepoDir, 'ran.marker');
    const p = path.join(inRepoDir, 'claude');
    await writeFile(repoCtx, p, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    await chmod(repoCtx, p, 0o755);
    // 指进仓库的 PATH 项被剔除:默认解析根本找不到它
    const viaPath = bySlot(
      f.build(
        { backends: [CLAUDE_BINDING] },
        { envSource: { PATH: `${inRepoDir}:${SYS_PATH}`, HOME: f.fakeHome } },
      ),
      'codex',
    );
    expect(await viaPath.complete(REQ)).toMatchObject({ reason: 'not_installed' });
    // 注入的 which 直接给出仓库内路径 + 已核实的参数集(内部构造)才能走到 runLlm,被它的 BINARY_DENIED 挡下
    const be = new CliBackend({
      slot: 'codex',
      args: { ...CLAUDE_ARGS, verified: true },
      provider: undefined,
      model: 'claude-test-1',
      vendorOverrides: {},
      resetTz: 'UTC',
      deps: f.deps({ which: () => p }),
    });
    expect(path.relative(REPO_ROOT, inRepoDir).startsWith('..')).toBe(false);
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_installed',
      detail: 'binary_denied',
    });
    expect(await exists(marker)).toBe(false);
  });
});

describe('R3 厂商与配置门', () => {
  it('厂商 unknown(pi 的模型族查不到)→ not_configured,不 spawn', async () => {
    const f = await fixture('be-unk-');
    const marker = f.rec('ran.marker');
    await f.install('pi', `echo ran > '${marker}'; printf '%s' '${FIXED_JSON}'`);
    const be = bySlot(
      f.build({
        backends: [{ slot: 'glm', cli: 'pi', provider: 'openrouter', model: 'mystery-9' }],
      }),
      'glm',
    );
    expect(be.vendor).toBe('unknown');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'unknown_vendor',
    });
    expect(await exists(marker)).toBe(false);
    expect(f.budget.used).toBe(0);
  });

  it('claude 绑定到别家模型(厂商矛盾)→ unknown → 不 spawn(不能把 claude 配成别家绕过 #18)', async () => {
    const f = await fixture('be-contra-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'`);
    const be = bySlot(
      f.build({ backends: [{ slot: 'codex', cli: 'claude', model: 'gpt-test-1' }] }),
      'codex',
    );
    expect(be.vendor).toBe('unknown');
    expect((await be.complete(REQ)).ok).toBe(false);
    expect(await exists(marker)).toBe(false);
  });

  it('覆盖层追加的新模型族可推出厂商;冲突的覆盖在构造时抛错', async () => {
    const f = await fixture('be-override-');
    const list = f.build({
      backends: [{ slot: 'kimi', cli: 'pi', provider: 'acme', model: 'foobar-1' }],
      vendor_overrides: { foobar: 'acmeco' },
    });
    expect(bySlot(list, 'kimi').vendor).toBe('acmeco');
    expect(() =>
      f.build({
        backends: [CLAUDE_BINDING],
        vendor_overrides: { gpt: 'anthropic' },
      }),
    ).toThrow(/CFG_VENDOR_OVERRIDE_DENIED/);
  });

  it('绑定不完整:缺 model / pi 缺 provider / claude 配 provider / 参数以 - 开头 → not_configured,不 spawn', async () => {
    const f = await fixture('be-binding-');
    const marker = f.rec('ran.marker');
    for (const n of ['claude', 'codex', 'pi']) await f.install(n, `echo ran >> '${marker}'`);
    const mk = (b: object, slot: string) =>
      bySlot(f.build({ backends: [{ slot, ...b } as never] }), slot);
    const expectations: [object, string, string][] = [
      [{ cli: 'claude' }, 'codex', 'model_required'],
      [{ cli: 'pi', model: 'glm-1' }, 'glm', 'provider_required'],
      [
        { cli: 'claude', model: 'claude-1', provider: 'anthropic' },
        'codex',
        'provider_not_applicable',
      ],
      [{ cli: 'codex', model: '-gpt-1' }, 'codex', 'bad_binding'],
      [{ cli: 'pi', model: 'glm-1', provider: '--evil' }, 'glm', 'bad_binding'],
    ];
    for (const [b, slot, detail] of expectations) {
      expect(await mk(b, slot).complete(REQ), detail).toEqual({
        ok: false,
        reason: 'not_configured',
        detail,
      });
    }
    expect(await exists(marker)).toBe(false);
  });

  it('未绑定的槽位是总返回 not_configured 的占位;工厂恒按固定兜底链顺序返回', async () => {
    const f = await fixture('be-slots-');
    const list = f.build({ backends: [PI_BINDING] });
    expect(list.map((b) => b.slot)).toEqual([...JUDGE_HOP_CHAIN]);
    const ph = bySlot(list, 'kimi');
    expect(ph.vendor).toBe('unknown');
    expect(await ph.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'slot_not_bound',
    });
    expect(f.budget.used).toBe(0);
    // core 里没有任何私人账号/渠道写死配置:空配置下五个槽位全是占位
    const none = f.build({});
    for (const b of none) {
      expect(await b.complete(REQ)).toMatchObject({ reason: 'not_configured' });
    }
  });

  it('未允许 egress → not_configured,不 spawn(用户没给 --run-llm --allow-egress)', async () => {
    const f = await fixture('be-egress-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { allowEgress: false }), 'codex');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'egress_not_allowed',
    });
    expect(await exists(marker)).toBe(false);
    // 正向控制:同一套配置允许 egress 就会跑
    const ok = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { allowEgress: true }), 'codex');
    expect((await ok.complete(REQ)).ok).toBe(true);
    expect(await exists(marker)).toBe(true);
  });
});

describe('R3 unverified 门', () => {
  it('参数集 verified:false 且二进制清单为空/缺省 → not_configured(unverified_cli_flags),不 spawn', async () => {
    const f = await fixture('be-unver-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    const refuse = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { allowUnverified: [] }),
      'codex',
    );
    expect(await refuse.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'unverified_cli_flags',
    });
    const dflt = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { allowUnverified: undefined }),
      'codex',
    );
    expect(await dflt.complete(REQ)).toMatchObject({ detail: 'unverified_cli_flags' });
    expect(await exists(marker)).toBe(false);
    expect(f.budget.used).toBe(0);
    // 正向控制:清单里有这个二进制就会跑
    const allow = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect((await allow.complete(REQ)).ok).toBe(true);
    expect(await exists(marker)).toBe(true);
  });

  it('清单不含解析到的二进制(例如真 CLI 的位置)→ 仍拒绝,且没被执行', async () => {
    const f = await fixture('be-unver-out-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    const be = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { allowUnverified: ['/opt/somewhere/else/claude'] }),
      'codex',
    );
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'unverified_cli_flags',
    });
    expect(await exists(marker)).toBe(false);
  });

  it('清单按 realpath 比较:清单给符号链接路径、PATH 解析到真文件(或反过来)同样放行;指向别的文件则拒', async () => {
    const f = await fixture('be-unver-sym-');
    const realDir = path.join(f.dir, 'real');
    await mkdirp(f.ctx, realDir);
    const marker = f.rec('ran.marker');
    const realBin = path.join(realDir, 'claude');
    await writeFile(
      f.ctx,
      realBin,
      `#!/bin/sh\ncat >/dev/null; echo ran > '${marker}'; printf x\n`,
      {
        mode: 0o755,
      },
    );
    await chmod(f.ctx, realBin, 0o755);
    const link = path.join(f.bin, 'claude');
    await symlink(f.ctx, realBin, link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true); // 正向控制:链接确实建成了
    // 清单给真文件路径,PATH 解析到的是链接 → realpath 相同,放行
    const ok = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { allowUnverified: [realBin] }),
      'codex',
    );
    expect((await ok.complete(REQ)).ok).toBe(true);
    expect(await exists(marker)).toBe(true);
    // 清单给的是另一个文件 → 拒
    const decoy = path.join(realDir, 'decoy');
    await writeFile(f.ctx, decoy, '#!/bin/sh\n', { mode: 0o755 });
    const no = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { allowUnverified: [decoy] }),
      'codex',
    );
    expect(await no.complete(REQ)).toMatchObject({ detail: 'unverified_cli_flags' });
  });
});

describe('R3 预算、env、串行化、HOME 位置', () => {
  it('spawn 预算耗尽 → error(spawn_limit),不再 spawn', async () => {
    const f = await fixture('be-budget-', { budget: 1 });
    const counter = f.rec('count.txt');
    await f.install(
      'claude',
      `cat >/dev/null; echo x >> '${counter}'; printf '%s' '${FIXED_JSON}'`,
    );
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect((await be.complete(REQ)).ok).toBe(true);
    expect(await be.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'spawn_limit' });
    expect(lines(await f.read(counter)).length).toBe(1);
    expect(f.budget.used).toBe(1);
  });

  it('env:key/token/base_url/NODE_OPTIONS 等白名单外变量一律不传;PATH/HOME 传(正向控制)', async () => {
    const f = await fixture('be-env-');
    const dump = f.rec('env.txt');
    await f.install('claude', `cat >/dev/null; env > '${dump}'; printf x`);
    const names = {
      apiKey: ['FAKE', 'API', 'KEY'].join('_'),
      token: ['SOME', 'TOKEN'].join('_'),
      anthropic: ['ANTHROPIC', 'API', 'KEY'].join('_'),
      base: ['ANTHROPIC', 'BASE', 'URL'].join('_'),
      node: 'NODE_OPTIONS',
      codexHome: 'CODEX_HOME',
    };
    const secret = fakeSecret('envleak');
    const envSource: Record<string, string | undefined> = {
      PATH: `${f.bin}:${SYS_PATH}`,
      HOME: f.fakeHome,
      LANG: 'C',
    };
    for (const n of Object.values(names)) envSource[n] = secret;
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { envSource }), 'codex');
    expect((await be.complete(REQ)).ok).toBe(true);
    const out = (await f.read(dump)) ?? '';
    expect(out).toContain(`HOME=${f.fakeHome}`);
    expect(out).toContain('PATH=');
    expect(out).not.toContain(secret);
    for (const n of Object.values(names)) expect(out).not.toMatch(new RegExp(`^${n}=`, 'm'));
  });

  it('同一 state 目录下的并发调用被串行化(共享的固定 cwd 不互相撞)', async () => {
    const f = await fixture('be-serial-');
    await f.install('claude', `cat >/dev/null; touch residue.tmp; sleep 0.4; printf x`);
    await f.install('codex', `cat >/dev/null; touch residue.tmp; sleep 0.4; printf x`);
    const list = f.build({
      backends: [CLAUDE_BINDING, { slot: 'maas-deepseek', cli: 'codex', model: 'gpt-test-1' }],
    });
    const rs = await Promise.all([
      bySlot(list, 'codex').complete(REQ),
      bySlot(list, 'maas-deepseek').complete(REQ),
    ]);
    expect(rs.map((r) => r.ok)).toEqual([true, true]);
  });

  it('跨进程锁:已有未过期的锁 → error(busy),不 spawn;过期的锁被接管', async () => {
    const f = await fixture('be-lock-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `cat >/dev/null; echo ran > '${marker}'; printf x`);
    // 模拟另一个进程持有锁
    const cwd = path.join(f.ctx.stateDir, 'reflect', 'cwd');
    await mkdirp(f.ctx, cwd, 0o700);
    await symlink(f.ctx, cwd, path.join(f.ctx.stateDir, 'reflect', 'llm.lock'));
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect(await be.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'busy' });
    expect(await exists(marker)).toBe(false);
    const stale = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { lockStaleMs: 0 }), 'codex');
    expect((await stale.complete(REQ)).ok).toBe(true);
    expect(await exists(marker)).toBe(true);
    // 跑完后锁已释放
    expect(await exists(path.join(f.ctx.stateDir, 'reflect', 'llm.lock'))).toBe(false);
  });

  it('HOME/XDG 指进仓库(KIT_TMP 之外)→ not_configured(env_in_repo);指进 KIT_TMP 则正常', async () => {
    const f = await fixture('be-homerepo-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `cat >/dev/null; echo ran > '${marker}'; printf x`);
    const repoCtx = baseCtx();
    const inRepo = await mkdtemp(repoCtx, path.join(repoCtx.stateDir, 'test-tmp'), 'be-home-');
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR']) {
      const envSource = { PATH: `${f.bin}:${SYS_PATH}`, HOME: f.fakeHome, [name]: inRepo };
      const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { envSource }), 'codex');
      expect(await be.complete(REQ), name).toEqual({
        ok: false,
        reason: 'not_configured',
        detail: 'env_in_repo',
      });
    }
    expect(await exists(marker)).toBe(false);
    const good = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect((await good.complete(REQ)).ok).toBe(true);
  });
});

/**
 * A5:形状表、`rsi hooks --print`、`rsi hint --format`、`rsi session --print`(contracts §20.15-3 R20-15.8–15.10、R20-15.25、§20.10 A5 三行)。
 */
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { HOME_WRITE_TABLE } from '../../../src/contracts/sync.js';
import {
  HOOK_EVIDENCE_LEVELS,
  HOOK_EVIDENCE_WRITABLE,
  PI_EXTENSION_SOURCE_PLAIN,
  PRODUCTION_SHAPES,
  formatHintOutput,
  isShapeWritable,
  shapeVersionOk,
} from '../../../src/contracts/rsi-hooks.js';
import { RSI_SESSION_MAX_DAYS, RsiSessionSchema } from '../../../src/contracts/rsi.js';
import { HOOKS_AGENT_ROOT_RELS, HOOKS_TARGET_RELS } from '../../../src/io/hooks-fs.js';
import { runHint } from '../../../src/rsi/hint.js';
import { judgeSession, utcToday } from '../../../src/rsi/session.js';
import {
  SESSION_PRINT_DAYS,
  runSessionPrint,
  sessionSnippet,
} from '../../../src/rsi/session-print.js';
import type { RsiConfigOn } from '../../../src/rsi/config.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint } from '../../../src/rsi/config.js';
import { makeTickFx, type TickFx } from '../b5a-fixture.js';
import { NOW, baseState, seed } from '../ro-fixture.js';
import { AGENTS, jsonOf, makeHx } from './a5-fixture.js';

describe('形状表(R20-15.8):生产表冻结,三家证据都是「假设」', () => {
  it('结构、固定写对象与 HOME_WRITE_TABLE 的 kit-hooks 三条逐项相等', () => {
    const tableHooks = HOME_WRITE_TABLE.filter((e) => e.owner === 'kit-hooks').map((e) => e.path);
    expect(tableHooks.sort()).toEqual(Object.values(HOOKS_TARGET_RELS).sort());
    for (const a of AGENTS) {
      const s = PRODUCTION_SHAPES[a];
      expect(s.agent).toBe(a);
      expect(s.evidence, a).toBe('假设'); // 形状核实是主代理之后的真实环境动作,这里不得标成已核实
      expect(s.target_rel).toBe(HOOKS_TARGET_RELS[a]);
      expect(s.agent_root_rel).toBe(HOOKS_AGENT_ROOT_RELS[a]);
      expect(s.shape_version).toMatch(/^[a-z]+-\d+$/);
      expect(s.failure_handling.length).toBeGreaterThan(0);
      expect(isShapeWritable(s, '1.0.0'), a).toBe(false);
      expect(Object.isFrozen(s), a).toBe(true);
    }
    expect(() => {
      (PRODUCTION_SHAPES.claude as { evidence: string }).evidence = '公开文档';
    }).toThrow(TypeError);
    // 只有 claude 有变体 canary 与本地覆盖文件;codex 的信任步骤只在输出里提示
    expect(
      PRODUCTION_SHAPES.claude.kind === 'json-merge' && PRODUCTION_SHAPES.claude.variants.canary,
    ).not.toBeNull();
    expect(PRODUCTION_SHAPES.codex.trust_step).not.toBeNull();
    expect(
      PRODUCTION_SHAPES.claude.kind === 'json-merge' &&
        PRODUCTION_SHAPES.claude.local_duplicate_rel,
    ).toBe('.claude/settings.local.json');
  });

  it('isShapeWritable:四个证据级别 × 版本范围(区间边界、未知版本、无法解析 → fail closed)', () => {
    expect([...HOOK_EVIDENCE_WRITABLE].sort()).toEqual(['公开文档', '实测运行'].sort());
    for (const e of HOOK_EVIDENCE_LEVELS) {
      const s = { ...PRODUCTION_SHAPES.claude, evidence: e };
      expect(isShapeWritable(s, undefined), e).toBe(HOOK_EVIDENCE_WRITABLE.includes(e));
    }
    const ranged = {
      ...PRODUCTION_SHAPES.claude,
      evidence: '实测运行' as const,
      agent_versions: { min: '1.2.0', max: '1.4.9' },
    };
    expect(shapeVersionOk(ranged, '1.2.0')).toBe(true);
    expect(shapeVersionOk(ranged, '1.4.9')).toBe(true);
    expect(shapeVersionOk(ranged, '1.1.9')).toBe(false);
    expect(shapeVersionOk(ranged, '1.5.0')).toBe(false);
    expect(shapeVersionOk(ranged, undefined)).toBe(false);
    expect(shapeVersionOk(ranged, 'x.y.z')).toBe(false);
    expect(isShapeWritable({ ...ranged, evidence: '假设' }, '1.3.0')).toBe(false);
    // null = 显式不限版本,但不代表证据已核实
    expect(shapeVersionOk({ ...PRODUCTION_SHAPES.claude, agent_versions: null }, undefined)).toBe(
      true,
    );
  });
});

describe('rsi hooks --print(R20-15.25:只输出形状表生成的固定内容)', () => {
  it('claude:可粘贴的 hooks 片段(与形状表一致);标明证据与 verified;只用 ~/ 相对写法;零读写', async () => {
    const hx = await makeHx('a5-print-claude-');
    const before = await hx.tree();
    const r = await hx.run(['--print', '--agent', 'claude'], { shapes: PRODUCTION_SHAPES });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('# shape=claude-1 variant=plain evidence=假设 verified=no');
    expect(r.out).toContain('~/.claude/settings.json');
    expect(r.out).not.toContain(hx.home);
    const body = r.out
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n')
      .trim();
    expect(JSON.parse(body)).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: 'agent-kit rsi hint --agent claude --format claude-json',
                timeout: 5,
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [{ type: 'command', command: 'agent-kit rsi poke --agent claude', timeout: 5 }],
          },
        ],
      },
    });
    expect(r.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before); // 连 agent 根都不需要存在
    // 测试形状表(已核实)只改变 verified 的标注
    const v = await hx.run(['--print', '--agent', 'claude']);
    expect(v.out).toContain('evidence=公开文档 verified=yes');
  });

  it('codex:同样的片段 + 信任步骤提示(kit 不写 config.toml);pi:整份扩展源码', async () => {
    const hx = await makeHx('a5-print-others-');
    const c = await hx.run(['--print', '--agent', 'codex'], { shapes: PRODUCTION_SHAPES });
    expect(c.code).toBe(0);
    expect(c.out).toContain('# 信任步骤:');
    expect(c.out).toContain('agent-kit rsi hint --agent codex --format codex-json');
    const p = await hx.run(['--print', '--agent', 'pi'], { shapes: PRODUCTION_SHAPES });
    expect(p.code).toBe(0);
    expect(p.out).toContain(PI_EXTENSION_SOURCE_PLAIN.trimEnd());
    expect(p.out).toContain('~/.pi/agent/extensions/agent-kit-rsi.ts');
  });

  it('--json:固定键集,不含片段;result=printed、write_level=null', async () => {
    const hx = await makeHx('a5-print-json-');
    const r = await hx.run(['--print', '--agent', 'pi', '--json'], { shapes: PRODUCTION_SHAPES });
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toEqual({
      mode: 'print',
      agent: 'pi',
      shape_version: 'pi-1',
      verified: false,
      plan: { kind: 'print', before_exists: null, ops: [] },
      result: 'printed',
      txn_id: null,
      write_level: null,
      maintenance: 'none',
      maintenance_kind: null,
    });
  });
});

describe('hint --format(R20-3.3.5;文本与字节上限同 R20-3.3.2)', () => {
  it('formatHintOutput:固定包装、JSON 转义、空文本 → 空串', () => {
    for (const f of ['claude-json', 'codex-json'] as const) {
      const out = formatHintOutput(f, 'agent-kit RSI: "引号"\n');
      expect(out.endsWith('\n')).toBe(true);
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'agent-kit RSI: "引号"',
        },
      });
      expect(formatHintOutput(f, '')).toBe('');
      expect(formatHintOutput(f, '\n')).toBe('');
    }
  });

  async function armed(prefix: string): Promise<TickFx> {
    const f = await makeTickFx(prefix, { noSeed: true });
    const cfg = await loadRsiConfig({ home: f.home });
    if (cfg.status !== 'on') throw new Error('off');
    const policy = await buildRsiPolicy(cfg);
    await seed(f, {
      state: baseState({
        armed_listing: {
          at: NOW,
          policy_fp: policyFingerprint(policy),
          agents: [...policy.agents],
          projects: 3,
          excluded: 0,
          unknown_sessions: 0,
        },
      }),
    });
    return f;
  }
  const deps = (f: TickFx) => ({
    env: f.env,
    writeAudit: (op: string, p: string) => void f.audit.push({ op, path: p }),
    now: () => new Date(Date.parse(NOW)),
    clockMs: () => 0,
  });
  const TEXT = 'agent-kit RSI: 待确认,将采集 3 个项目。仅在用户要求时运行 agent-kit rsi confirm。';

  it('--agent <a> --format <claude-json|codex-json> → JSON 包装,文本不变、≤ 200 字节;不带 --format 仍是纯文本', async () => {
    for (const [agent, format] of [
      ['claude', 'claude-json'],
      ['codex', 'codex-json'],
    ] as const) {
      const f = await armed('a5-hint-fmt-');
      const out = await runHint(['--agent', agent, '--format', format], deps(f));
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TEXT },
      });
      expect(Buffer.byteLength(TEXT)).toBeLessThanOrEqual(200);
      // 去重照旧:同一窗口内同一 agent 第二次输出空串
      expect(await runHint(['--agent', agent, '--format', format], deps(f))).toBe('');
    }
    const f = await armed('a5-hint-plain-');
    expect(await runHint(['--agent', 'claude'], deps(f))).toBe(`${TEXT}\n`);
  });

  it('非法 / 乱序 / 缺值的参数 → 空串(退 0 由入口保证),不写去重标记', async () => {
    const f = await armed('a5-hint-bad-');
    for (const argv of [
      ['--agent', 'claude', '--format', 'json'],
      ['--agent', 'claude', '--format'],
      ['--agent', 'claude', '--format', 'claude-json', '--x'],
      ['--format', 'claude-json', '--agent', 'claude'],
      ['--agent', 'claude', '--fmt', 'claude-json'],
    ]) {
      f.audit.length = 0;
      expect(await runHint(argv, deps(f)), argv.join(' ')).toBe('');
      expect(f.audit).toEqual([]);
    }
    // 之后合法调用仍能输出(上面的空串没有占用去重窗口)
    expect(await runHint(['--agent', 'claude', '--format', 'claude-json'], deps(f))).not.toBe('');
  });
});

describe('rsi session --print(kit 不写用户配置,R20-2.1)', () => {
  const NOW_D = new Date('2026-11-02T09:30:00.000Z');

  it('打印的 [rsi.session] 能过 RsiSessionSchema,且按 R20-16.3 判定为 ok(今天 < expires ≤ 今天 + 90 天)', () => {
    const text = sessionSnippet(NOW_D);
    const toml = parseToml(text) as { rsi: { session: Record<string, unknown> } };
    const parsed = RsiSessionSchema.safeParse(toml.rsi.session);
    expect(parsed.success).toBe(true);
    expect(toml.rsi.session['expires']).toBe('2026-12-02');
    expect(SESSION_PRINT_DAYS).toBeLessThanOrEqual(RSI_SESSION_MAX_DAYS);
    const cfg = {
      session: toml.rsi.session,
      agents: ['claude', 'codex', 'pi'],
    } as unknown as RsiConfigOn;
    for (const a of ['claude', 'codex', 'pi'] as const) {
      expect(judgeSession(cfg, a, utcToday(NOW_D)), a).toMatchObject({ kind: 'ok' });
    }
  });

  it('命令:只接受 --print;零输出以外的副作用为 0;多余参数 → 2 unknown_arg', async () => {
    let out = '';
    let err = '';
    const run = (argv: string[]) =>
      runSessionPrint(
        { argv, stdout: (t) => (out += t), stderr: (t) => (err += t) },
        { now: () => NOW_D },
      );
    expect(await run(['--print'])).toBe(0);
    expect(out).toBe(sessionSnippet(NOW_D));
    expect(out).toContain('agent-kit 不会替你写这个文件');
    expect(out).not.toMatch(/\/Users\/|\/home\//);
    out = '';
    for (const argv of [
      [],
      ['--print', '--write'],
      ['--write'],
      ['--print', '--print'],
      ['--agent', 'claude'],
    ]) {
      err = '';
      expect(await run(argv), argv.join(' ')).toBe(2);
      expect(err).toBe('RSI_USAGE reason=unknown_arg\n');
      expect(out).toBe('');
    }
  });
});

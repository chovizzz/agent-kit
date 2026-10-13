/**
 * A16–A20 验收脚本自身的测试(脚本的纯函数部分;脚本对 dist 的实跑由 ops/accept-p1.sh 负责):
 *  - A16 矩阵夹具对 **src** 同样成立(合法全过、非法按原因码拒);脚本的"逐条核对原因码"逻辑真的会报错;
 *  - A19 的快照比对对真实写入报差异、对无变化报空(探测本身有效);
 *  - A20 的标记文件状态机与"替换必须恰好匹配 1 次";
 *  - accept-p1.sh 入口:--list / --only / 退出码约定。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createRedactor } from '../../src/redact/index.js';
import { makeReflectorOutputSchema } from '../../src/contracts/reflect.js';
import { validateReflectorOutput } from '../../src/reflect/validate.js';
import { exists } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { callLib, commitAll, evalLib, guardRealHome, makeFx, SAFE_PATH } from './helpers.js';
import { spawnSync } from 'node:child_process'; // eslint-disable-line no-restricted-imports -- 与 helpers.ts 同理:验收脚本的黑盒测试必须起子进程
import { REPO_ROOT } from './helpers.js';

guardRealHome();

interface ValidCase {
  name: string;
  raw: string;
  kept: number;
  observations?: number;
}
interface InvalidCase {
  name: string;
  raw: string;
  expect: { code?: string; path?: string; unknown?: string; drop?: string };
}

const valid = (): ValidCase[] => callLib('a16.mjs', 'validCases', [[]])[0] as ValidCase[];
const invalid = (): InvalidCase[] => callLib('a16.mjs', 'invalidCases', [[]])[0] as InvalidCase[];

const EXCERPT =
  '以后提交代码前必须先运行 lint 检查并修复全部告警再提交,并且不允许带着任何告警直接把改动合并进主分支';
const redactor = createRedactor({ timeout_ms: 5000 });
const vctx = {
  allowedAliases: new Set(['e1', 'e2']),
  excerpts: [EXCERPT],
  existingIds: new Set(['existing-rule']),
  redactor,
};

describe('A16 矩阵夹具(src 上同样成立)', () => {
  it('合法夹具全部通过,保留数与 observations 数一致(正向控制)', () => {
    const cases = valid();
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) {
      const r = validateReflectorOutput(c.raw, vctx);
      expect(r.ok, c.name).toBe(true);
      if (r.ok) {
        expect(r.proposals.length, c.name).toBe(c.kept);
        expect(r.observations.length, c.name).toBe(c.observations ?? 0);
        expect(r.dropped, c.name).toEqual({});
      }
    }
  });

  it('非法夹具逐条按期望原因码被拒;schema 类要命中指定位置/未知键', () => {
    const cases = invalid();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const schema = makeReflectorOutputSchema({});
    const seen = new Set<string>();
    for (const c of cases) {
      const r = validateReflectorOutput(c.raw, vctx);
      if (c.expect.drop !== undefined) {
        expect(r.ok, c.name).toBe(true);
        if (r.ok) {
          expect(r.proposals, c.name).toHaveLength(0);
          expect(r.dropped[c.expect.drop], c.name).toBe(1);
        }
        seen.add(c.expect.drop);
        continue;
      }
      expect(r.ok, c.name).toBe(false);
      if (!r.ok) {
        expect(r.code, c.name).toBe(c.expect.code);
        seen.add(r.code);
      }
      if (c.expect.code === 'schema_invalid') {
        const p = schema.safeParse(JSON.parse(c.raw));
        const issues = p.success ? [] : p.error.issues;
        expect(
          issues.some(
            (i) =>
              i.path.join('.') === c.expect.path &&
              (c.expect.unknown === undefined ||
                (i.code === 'unrecognized_keys' && i.keys.includes(c.expect.unknown))),
          ),
          c.name,
        ).toBe(true);
      }
    }
    for (const code of [
      'schema_invalid',
      'not_json_object',
      'output_too_large',
      'placeholder_in_output',
      'output_residual',
      'injection_suspected_local',
      'evidence_alias_unknown',
      'id_conflict',
      'echo_detected',
    ])
      expect(seen.has(code), `矩阵没覆盖 ${code}`).toBe(true);
  });

  it('A16 脚本的"原因码核对"会真的报错:假校验器给错原因码时,每条非法夹具都产生一条问题', () => {
    const n = invalid().length;
    const problems = evalLib(
      'a16.mjs',
      `async (m) => {
        const valid = new Map(m.validCases().map((c) => [c.raw, c]));
        const mods = {
          validate: { validateReflectorOutput: (raw) => {
            const v = valid.get(raw);
            return v ? { ok: true, proposals: new Array(v.kept).fill(0), observations: new Array(v.observations ?? 0).fill(0), dropped: {} } : { ok: false, code: 'WRONG_CODE', detail: '' };
          } },
          contractsReflect: { makeReflectorOutputSchema: () => ({ safeParse: () => ({ success: true }) }) },
          redact: { createRedactor: () => ({}) },
        };
        return (await m.runMatrix(mods)).problems.length;
      }`,
    );
    expect(problems).toBe(n);
  });

  it('A16 脚本:合法夹具被拒时整个矩阵判基线不对并提前返回(不给非法夹具"碰巧被拒"的机会)', () => {
    const r = evalLib(
      'a16.mjs',
      `async (m) => {
        const mods = {
          validate: { validateReflectorOutput: () => ({ ok: false, code: 'schema_invalid', detail: '' }) },
          contractsReflect: { makeReflectorOutputSchema: () => ({ safeParse: () => ({ success: true }) }) },
          redact: { createRedactor: () => ({}) },
        };
        const x = await m.runMatrix(mods);
        return { problems: x.problems.length, invalidRun: x.stats.invalid };
      }`,
    ) as { problems: number; invalidRun: number };
    expect(r.problems).toBe(valid().length);
    expect(r.invalidRun).toBe(0);
  });
});

describe('A19 快照比对', () => {
  it('A19 对一次真实写入报出差异;无变化时为空;删除也算差异(探测本身有效)', async () => {
    const fx = await makeFx('p1ops-');
    await mkdirp(fx.ctx, path.join(fx.dir, 'watched'));
    await writeFile(fx.ctx, path.join(fx.dir, 'watched', 'a.txt'), 'one');
    const snap = (): unknown =>
      callLib('a19.mjs', 'snapshotTargets', [
        [{ w: path.join(fx.dir, 'watched'), f: path.join(fx.dir, 'x') }],
      ])[0];
    const s0 = snap();
    expect(callLib('a19.mjs', 'compareSnapshots', [[s0, snap()]])[0]).toEqual({
      names: [],
      entries: 0,
    });
    await writeFile(fx.ctx, path.join(fx.dir, 'watched', 'b.txt'), 'two');
    const s1 = snap();
    expect(callLib('a19.mjs', 'compareSnapshots', [[s0, s1]])[0]).toEqual({
      names: ['w'],
      entries: 1,
    });
    await writeFile(fx.ctx, path.join(fx.dir, 'x'), 'new top-level file');
    const s2 = snap();
    const d = callLib('a19.mjs', 'compareSnapshots', [[s1, s2]])[0] as { names: string[] };
    expect(d.names).toEqual(['f']);
    // 内容改变(同名、同大小)也要报
    await writeFile(fx.ctx, path.join(fx.dir, 'watched', 'a.txt'), 'ONE');
    const d2 = callLib('a19.mjs', 'compareSnapshots', [[s2, snap()]])[0] as { names: string[] };
    expect(d2.names).toEqual(['w']);
  });
});

describe('freshDist(A16–A19 的前置检查)', () => {
  it('dist 比 src 新 → ok;src/cli.ts/adapters 更新 → 陈旧;存在 .mut-bak → 拒绝;缺 dist → 拒绝', async () => {
    const fx = await makeFx('fresh-');
    await fx.put('src/a.ts', 'export {};\n');
    await fx.put('adapters/x/index.ts', 'export {};\n');
    await fx.put('cli.ts', 'export {};\n');
    const cli = await fx.put('dist/cli.js', '//\n');
    await fx.put('dist/src/cli.js', '//\n');
    const call = (): { ok: boolean; why: string } =>
      callLib('accept-p1.mjs', 'freshDist', [[{ root: fx.root, cli }]])[0] as {
        ok: boolean;
        why: string;
      };
    const utimes = async (file: string, _a: Date, m: Date): Promise<void> => {
      const stamp =
        m.toISOString().replace(/[-:T]/g, '').slice(0, 12) + '.' + m.toISOString().slice(17, 19);
      const r = spawnSync('touch', ['-t', stamp, file], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`touch 失败:${r.stderr}`);
    };
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    for (const f of ['src/a.ts', 'adapters/x/index.ts', 'cli.ts'])
      await utimes(path.join(fx.root, f), old, old);
    await utimes(cli, fresh, fresh);
    await utimes(path.join(fx.root, 'dist/src/cli.js'), fresh, fresh);
    expect(call().ok).toBe(true);
    for (const f of ['src/a.ts', 'adapters/x/index.ts', 'cli.ts']) {
      const t = new Date(Date.now() + 10_000);
      await utimes(path.join(fx.root, f), t, t);
      const r = call();
      expect(r.ok, f).toBe(false);
      expect(r.why, f).toContain('dist 比 src 旧');
      await utimes(path.join(fx.root, f), old, old);
    }
    await fx.put('src/b.ts.mut-bak', 'x\n');
    expect(call().why).toContain('没还原');
    expect(
      callLib('accept-p1.mjs', 'freshDist', [[{ root: fx.root, cli: '/nonexistent/cli.js' }]])[0],
    ).toMatchObject({ ok: false });
  });
});

describe('A20 标记与变异工具', () => {
  const marker = (head: string, over: string[] = []): string =>
    [
      `head: ${head}`,
      'result: 6/6 red',
      ...['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((i) => `${i}: red`),
      ...over,
      '',
    ].join('\n');

  it('标记状态机:todo / done / stale / invalid(缺行、多余内容、result 不对)', async () => {
    const fx = await makeFx('a20-');
    const head = await commitAll(fx);
    const st = (): { state: string } =>
      callLib('a20.mjs', 'a20Status', [[fx.root]])[0] as { state: string };
    expect(st().state).toBe('todo');
    await fx.put('.state/accept/a20.done', marker(head));
    expect(st().state).toBe('done');
    await fx.put('.state/accept/a20.done', marker('0'.repeat(40)));
    expect(st().state).toBe('stale');
    await fx.put('.state/accept/a20.done', marker(head, ['extra: 1']));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a20.done', marker(head).replace('M4: red\n', ''));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a20.done', marker(head).replace('6/6 red', '5/6 red'));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a20.done', marker(head).replace('M2: red', 'M2: green'));
    expect(st().state).toBe('invalid');
  });

  it('--write-marker 在工作树不干净时拒绝(退出 4,不跑任何变异、不写标记)', async () => {
    const fx = await makeFx('a20dirty-');
    await commitAll(fx);
    await fx.put('untracked.txt', 'dirty\n');
    const r = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'ops', 'accept', 'lib', 'a20.mjs'),
        '--run',
        '--write-marker',
        '--root',
        fx.root,
      ],
      { encoding: 'utf8', timeout: 60_000, env: { PATH: SAFE_PATH, KIT_TMP: fx.kit } },
    );
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('工作树不干净');
    expect(await exists(path.join(fx.root, '.state', 'accept', 'a20.done'))).toBe(false);
  });

  it('applyEdit:匹配 0 次或多次都抛错,恰好 1 次才替换', () => {
    const r = evalLib(
      'a20.mjs',
      `(m) => {
        const t = (f) => { try { return m.applyEdit(...f); } catch (e) { return 'ERR:' + e.message.slice(0, 12); } };
        return [t(['abc', 'x', 'y']), t(['axbx', 'x', 'y']), t(['axb', 'x', 'y'])];
      }`,
    ) as string[];
    expect(r[0]).toMatch(/^ERR:变异没有落到代码上/);
    expect(r[1]).toMatch(/^ERR:变异没有落到代码上/);
    expect(r[2]).toBe('ayb');
  });

  it('变异表:A20 恰好六处 M1–M6,每处至少有一个编辑与一个测试文件;全表至少 15 处', () => {
    const t = evalLib(
      'a20.mjs',
      '(m) => m.MUTATIONS.map((x) => ({ id: x.id, a20: !!x.a20, edits: x.edits.length, tests: x.tests.length }))',
    ) as { id: string; a20: boolean; edits: number; tests: number }[];
    expect(t.filter((x) => x.a20).map((x) => x.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
    expect(t.length).toBeGreaterThanOrEqual(15);
    for (const x of t) {
      expect(x.edits, x.id).toBeGreaterThan(0);
      expect(x.tests, x.id).toBeGreaterThan(0);
    }
  });
});

describe('ops/accept-p1.sh 入口', () => {
  const run = (args: string[], env: Record<string, string>) => {
    const r = spawnSync('bash', [path.join(REPO_ROOT, 'ops', 'accept-p1.sh'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: SAFE_PATH, ...env },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  it('--list 列出 A16–A20,A20 标为人工完成项并显示状态', async () => {
    const fx = await makeFx('p1entry-');
    const r = run(['--list', '--root', fx.root], fx.env());
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(['A16', 'A17', 'A18', 'A19', 'A20']);
    expect(lines[4]).toContain('【人工完成项】');
    expect(lines[4]).toContain('状态:未做');
  });

  it('--only 未知编号 → 2;--only A20 没有标记 → 4(未执行,不是通过);标记有效 → 0', async () => {
    const fx = await makeFx('p1entry2-');
    expect(run(['--only', 'A99', '--root', fx.root], fx.env()).status).toBe(2);
    const r = run(['--only', 'A20', '--root', fx.root], fx.env());
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('NOT-RUN');
    const head = await commitAll(fx);
    await fx.put(
      '.state/accept/a20.done',
      [
        'head: ' + head,
        'result: 6/6 red',
        ...['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((i) => `${i}: red`),
        '',
      ].join('\n'),
    );
    const ok = run(['--only', 'A20', '--root', fx.root], fx.env());
    expect(ok.status, ok.stdout).toBe(0);
    expect(ok.stdout).toContain('通过 1/1');
  });

  it('每个脚本型项目(A16–A19)都指向一个真实存在的 lib 文件', async () => {
    const lines = callLib('accept-p1.mjs', 'listLines', [['/nonexistent-root']])[0] as string[];
    expect(lines).toHaveLength(5);
    for (const l of lines.slice(0, 4)) {
      const m = /ops\/accept\/lib\/(\S+)$/.exec(l);
      expect(m, l).not.toBeNull();
      expect(
        await exists(path.join(REPO_ROOT, 'ops', 'accept', 'lib', m?.[1] ?? 'missing')),
        l,
      ).toBe(true);
    }
  });
});

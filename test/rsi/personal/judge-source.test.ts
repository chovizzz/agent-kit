/**
 * W9a 判官裁决读端口的生产适配器(`read/judge-source.ts`;contracts R20-18.34 ① ②、R20-18.36、W0-27):真实文件系统(KIT_TMP 下的临时目录)上的归属判定、安全读取、
 * 失败分类、一致性协议(读期间被换 → unreadable)、2 秒预算与零写入;端口契约套件同时跑「适配器」与「内存参照实现」,保证两者错误语义一致(假件与生产同契约)。
 */
import * as path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { RsiCounts } from '../../../src/contracts/rsi.js';
import type { IoContext } from '../../../src/io/paths.js';
import { lstat } from '../../../src/io/read-fs.js';
import {
  chmod,
  hardlink,
  mkdirp,
  remove,
  rename,
  symlink,
  writeFile,
} from '../../../src/io/safe-fs.js';
import {
  evaluateJudgeSignal,
  type JudgeSourceRead,
  type ProposalJudgeSource,
} from '../../../src/rsi/personal/judge-signal.js';
import {
  JUDGE_SOURCE_MAX_BYTES,
  makeProposalJudgeSource,
  type JudgeAttribution,
  type JudgeSourceDeps,
} from '../../../src/rsi/personal/read/judge-source.js';
import { makeTempDir, wideCtx } from '../../helpers/tmp.js';
import { treeOf } from '../rsi-fixture.js';
import {
  LINK,
  PID,
  RULE_TEXT,
  RUN,
  TARGET,
  env,
  personalProposal,
  sessionJudged,
} from './judge-fixture.js';

const KEY = 'p_0123456789abcdef';
const staged = (over: Partial<RsiCounts['staged'][number]> = {}): RsiCounts['staged'] => [
  { run_id: RUN, proposals: 1, evidence_keys: [KEY], tainted: false, ...over },
];
const P_ATTR: JudgeAttribution = { staged: staged(), classify: () => 'P' };

interface W {
  dir: string;
  fx: IoContext;
  state: string;
  reflect: string;
  runDir: string;
  propFile: string;
  ruleFile: string;
}

async function world(opts: { proposal?: string | null; rule?: string | null } = {}): Promise<W> {
  const { dir } = await makeTempDir('w9a-js-');
  const fx = wideCtx(dir);
  const state = path.join(dir, 'state');
  const reflect = path.join(state, 'reflect');
  const runDir = path.join(reflect, RUN);
  const w: W = {
    dir,
    fx,
    state,
    reflect,
    runDir,
    propFile: path.join(runDir, 'proposals', `${PID}.yaml`),
    ruleFile: path.join(runDir, 'rules', 'personal', `${TARGET}.md`),
  };
  await mkdirp(fx, path.join(runDir, 'proposals'), 0o755);
  await mkdirp(fx, path.join(runDir, 'rules', 'personal'), 0o755);
  const prop =
    opts.proposal === undefined ? stringify(sessionJudged({ verdict: 'reject' })) : opts.proposal;
  if (prop !== null) await writeFile(fx, w.propFile, prop, { mode: 0o644 });
  const rule = opts.rule === undefined ? RULE_TEXT : opts.rule;
  if (rule !== null) await writeFile(fx, w.ruleFile, rule, { mode: 0o644 });
  return w;
}

const ctl = (over: { aborted?: boolean } = {}): { signal: AbortSignal } => {
  const c = new AbortController();
  if (over.aborted === true) c.abort();
  return { signal: c.signal };
};

function source(w: W, over: Partial<JudgeSourceDeps> = {}): ProposalJudgeSource {
  return makeProposalJudgeSource({
    stateDir: w.state,
    attribution: async () => P_ATTR,
    ...over,
  });
}

const readOf = (w: W, over: Partial<JudgeSourceDeps> = {}, c = ctl()): Promise<JudgeSourceRead> =>
  source(w, over).read(RUN, PID, c);

const why = (r: JudgeSourceRead): string | null =>
  r.kind === 'unreadable' || r.kind === 'invalid' ? r.why : null;
/**
 * 目录位置上的符号链接:`statDirSafe` 用 `O_NOFOLLOW | O_DIRECTORY` 打开,各平台对「目录符号链接」的错误码不同
 * (Linux / BSD 可能给 ELOOP → `link`,macOS 给 ENOTDIR → `not_regular`)。语义是同一个:不跟随、`unreadable`;
 * 所以只认这两种原因,且必须是 `unreadable`(不是 `ok` / `run_gone` / `run_excluded`)。
 */
const dirLinkWhy = (r: JudgeSourceRead, prefix: string): string[] => {
  expect(r.kind).toBe('unreadable');
  return [`${prefix}_link`, `${prefix}_not_regular`];
};

describe('W9a 读适配器:归属(R20-18.34 ①)', () => {
  it('采集中的 run:读到解析后的提案与规则文本;经纯判定得到信号(端到端正向对照)', async () => {
    const w = await world();
    const r = await readOf(w);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.rule).toEqual({ target: TARGET, text: RULE_TEXT });
    expect((r.proposal as { id: string }).id).toBe(PID);
    const s = await evaluateJudgeSignal(LINK, source(w), env);
    expect(s).toMatchObject({
      kind: 'signal',
      verdict: 'reject',
      judge_provenance: 'session_confirmed',
    });
  });

  it('run 目录不存在 / reflect 目录不存在 → run_gone(gc 之后);同名普通文件不是目录 → unreadable', async () => {
    const w = await world();
    await remove(w.fx, w.runDir);
    expect(await readOf(w)).toEqual({ kind: 'run_gone' });
    await remove(w.fx, w.reflect);
    expect(await readOf(w)).toEqual({ kind: 'run_gone' });
    await mkdirp(w.fx, w.reflect);
    await writeFile(w.fx, w.runDir, 'x', { mode: 0o644 });
    expect(why(await readOf(w))).toBe('run_dir_not_regular');
  });

  it('run 目录 / reflect 目录是符号链接 → unreadable(不跟随);对照:换回真实目录即可读', async () => {
    const w = await world();
    const moved = `${w.runDir}-real`;
    await rename(w.fx, w.runDir, moved);
    await symlink(w.fx, moved, w.runDir);
    {
      const r = await readOf(w);
      expect(dirLinkWhy(r, 'run_dir')).toContain(why(r));
    }
    await remove(w.fx, w.runDir);
    await rename(w.fx, moved, w.runDir);
    expect((await readOf(w)).kind).toBe('ok');
    const movedReflect = `${w.reflect}-real`;
    await rename(w.fx, w.reflect, movedReflect);
    await symlink(w.fx, movedReflect, w.reflect);
    {
      const r = await readOf(w);
      expect(dirLinkWhy(r, 'reflect_dir')).toContain(why(r));
    }
  });

  it('TAINTED 标记存在 → run_excluded;标记不安全(是目录 / 符号链接)→ unreadable(读不出标记不得当作没被污染);无标记 → 可读', async () => {
    const w = await world();
    const taint = path.join(w.runDir, 'TAINTED');
    await writeFile(w.fx, taint, '{}', { mode: 0o644 });
    expect(await readOf(w)).toEqual({ kind: 'run_excluded' });
    await remove(w.fx, taint);
    await mkdirp(w.fx, taint);
    expect(why(await readOf(w))).toBe('taint_marker_not_regular');
    await remove(w.fx, taint);
    await symlink(w.fx, w.propFile, taint);
    expect(why(await readOf(w))).toBe('taint_marker_link');
    await remove(w.fx, taint);
    expect((await readOf(w)).kind).toBe('ok');
  });

  it('归属现算:counts 里没有该 run / 标 tainted / 证据有 X 或 U → run_excluded;全 P → 可读;归属读取抛错 → unreadable', async () => {
    const w = await world();
    const withAttr = (a: JudgeAttribution) => readOf(w, { attribution: async () => a });
    expect(await withAttr({ staged: [], classify: () => 'P' })).toEqual({ kind: 'run_excluded' });
    expect(await withAttr({ staged: staged({ tainted: true }), classify: () => 'P' })).toEqual({
      kind: 'run_excluded',
    });
    expect(await withAttr({ staged: staged(), classify: () => 'X' })).toEqual({
      kind: 'run_excluded',
    });
    expect(await withAttr({ staged: staged(), classify: () => 'U' })).toEqual({
      kind: 'run_excluded',
    });
    expect(await withAttr({ staged: staged({ evidence_keys: [] }), classify: () => 'P' })).toEqual({
      kind: 'run_excluded',
    });
    expect((await withAttr(P_ATTR)).kind).toBe('ok');
    const r = await readOf(w, {
      attribution: async () => {
        throw new Error('counts unreadable');
      },
    });
    expect(why(r)).toBe('attribution');
  });
});

describe('W9a 读适配器:安全读取与失败分类(R20-18.34 ②)', () => {
  it('采集中的 run 里提案目录 / 文件缺失 → unreadable(无从判断是否曾有 reject),不是 invalid', async () => {
    const w = await world({ proposal: null });
    expect(await readOf(w)).toMatchObject({ kind: 'unreadable', why: 'proposal_missing' });
    await remove(w.fx, path.join(w.runDir, 'proposals'));
    expect(await readOf(w)).toMatchObject({ kind: 'unreadable', why: 'proposals_dir_missing' });
  });

  it('提案是符号链接 / 硬链接(nlink > 1)→ unreadable;对照:普通文件可读', async () => {
    const w = await world();
    const real = path.join(w.dir, 'real.yaml');
    await rename(w.fx, w.propFile, real);
    await symlink(w.fx, real, w.propFile);
    expect(why(await readOf(w))).toBe('proposal_link');
    await remove(w.fx, w.propFile);
    await hardlink(w.fx, real, w.propFile);
    expect(why(await readOf(w))).toBe('proposal_hardlink');
    // 对照:普通文件可读(safe-fs 的 remove / rename 拒绝处理 nlink > 1 的目标,所以对照用一个全新的世界)
    expect((await readOf(await world())).kind).toBe('ok');
  });

  it('64 KiB 上限:恰好 65536 字节可读,多 1 字节 → unreadable(too_large);规则文件同口径', async () => {
    const base = stringify(sessionJudged({ verdict: 'reject' }));
    expect(JUDGE_SOURCE_MAX_BYTES).toBe(64 * 1024);
    // 注释行补齐到恰好 65536 字节(YAML 里的注释不影响解析)
    const fill = JUDGE_SOURCE_MAX_BYTES - Buffer.byteLength(base);
    const pad = (): string => `${base}${'#'.repeat(fill - 1)}\n`;
    const exact = pad();
    expect(Buffer.byteLength(exact)).toBe(JUDGE_SOURCE_MAX_BYTES);
    const w = await world({ proposal: exact });
    expect((await readOf(w)).kind).toBe('ok');
    await writeFile(w.fx, w.propFile, exact + '#', { mode: 0o644 });
    expect(why(await readOf(w))).toBe('proposal_too_large');
    const w2 = await world({ rule: `${RULE_TEXT}${'#'.repeat(JUDGE_SOURCE_MAX_BYTES)}` });
    expect(why(await readOf(w2))).toBe('rule_too_large');
  });

  it('YAML 无法解析 / 不是对象 → invalid(内容类);提案 id 形状不对(含 ../ 穿越)→ unreadable(来源链接损坏),在任何读取之前拒绝(归属没被调用)', async () => {
    const w1 = await world({ proposal: 'a: [unclosed\n' });
    expect(await readOf(w1)).toEqual({ kind: 'invalid', why: 'yaml' });
    const w2 = await world({ proposal: '- a\n- b\n' });
    expect(await readOf(w2)).toEqual({ kind: 'invalid', why: 'not_object' });
    const w3 = await world();
    let attributed = 0;
    const counting = source(w3, {
      attribution: async () => {
        attributed++;
        return P_ATTR;
      },
    });
    for (const bad of ['p1', '../x', '2026-11-09-001/../..', '2026-11-09-0011', '']) {
      const r = await counting.read(RUN, bad, ctl());
      expect(r, bad).toEqual({ kind: 'unreadable', why: 'proposal_id_shape' });
    }
    expect(await counting.read('../escape', PID, ctl())).toEqual({
      kind: 'unreadable',
      why: 'run_id_shape',
    });
    expect(attributed).toBe(0);
    // 对照:形状合法的 id 照常读取(归属被调用)
    expect((await counting.read(RUN, PID, ctl())).kind).toBe('ok');
    expect(attributed).toBeGreaterThan(0);
  });

  it('规则:文件不存在 / rules 目录不存在 → rule = null(由 ⑤ 判 rule_changed);规则是链接 / rules 目录是链接 → unreadable', async () => {
    const w = await world({ rule: null });
    const r = await readOf(w);
    expect(r).toMatchObject({ kind: 'ok', rule: null });
    await remove(w.fx, path.join(w.runDir, 'rules'));
    expect(await readOf(w)).toMatchObject({ kind: 'ok', rule: null });
    const w2 = await world();
    const real = path.join(w2.dir, 'real.md');
    await rename(w2.fx, w2.ruleFile, real);
    await symlink(w2.fx, real, w2.ruleFile);
    expect(why(await readOf(w2))).toBe('rule_link');
    const w3 = await world();
    const rulesReal = path.join(w3.dir, 'rules-real');
    await rename(w3.fx, path.join(w3.runDir, 'rules'), rulesReal);
    await symlink(w3.fx, rulesReal, path.join(w3.runDir, 'rules'));
    {
      const r = await readOf(w3);
      expect(dirLinkWhy(r, 'rules_dir')).toContain(why(r));
    }
  });

  it('提案 targets 取不出(多目标 / 非 kebab)→ 不读规则,rule = null;交给 ③ 拒绝', async () => {
    const p = sessionJudged({ verdict: 'reject' });
    const w = await world({ proposal: stringify({ ...p, targets: [TARGET, 'x-y'] }) });
    expect(await readOf(w)).toMatchObject({ kind: 'ok', rule: null });
    const w2 = await world({ proposal: stringify({ ...p, targets: ['../../etc/passwd'] }) });
    expect(await readOf(w2)).toMatchObject({ kind: 'ok', rule: null });
  });
});

describe('W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决)', () => {
  const race = async (mutate: (w: W) => Promise<void>, want: string): Promise<void> => {
    const w = await world();
    // 对照:不改动 → ok
    expect((await readOf(w)).kind).toBe('ok');
    const r = await readOf(w, { seam: { afterReads: () => mutate(w) } });
    expect(r, want).toEqual({ kind: 'unreadable', why: want });
  };

  it('提案在读与核对之间被改写(同路径、内容不同)→ race', async () => {
    await race(
      (w) =>
        writeFile(w.fx, w.propFile, `${stringify(sessionJudged({ verdict: 'accept' }))}# x\n`, {
          mode: 0o644,
        }),
      'race',
    );
  });

  it('提案被换成另一个文件(rename 覆盖)→ race', async () => {
    await race(async (w) => {
      const other = path.join(w.dir, 'other.yaml');
      await writeFile(w.fx, other, stringify(sessionJudged({ verdict: 'accept' })), {
        mode: 0o644,
      });
      await rename(w.fx, other, w.propFile);
    }, 'race');
  });

  it('规则被改写 / 规则被删 / 规则被新建(读时不存在)→ race', async () => {
    await race(
      (w) => writeFile(w.fx, w.ruleFile, `${RULE_TEXT}# edited\n`, { mode: 0o644 }),
      'race',
    );
    const w = await world();
    await remove(w.fx, w.ruleFile);
    // 读时规则不存在,读后出现 → race(而不是返回 rule = null 的结论)
    const r = await readOf(w, {
      seam: { afterReads: () => writeFile(w.fx, w.ruleFile, RULE_TEXT, { mode: 0o644 }) },
    });
    expect(r).toEqual({ kind: 'unreadable', why: 'race' });
    const w2 = await world();
    const r2 = await readOf(w2, { seam: { afterReads: () => remove(w2.fx, w2.ruleFile) } });
    expect(r2).toEqual({ kind: 'unreadable', why: 'race' });
  });

  it('排除标记在读期间出现 → race(不返回 ok,也不当作无裁决);父目录被换(run 目录 rename 后重建)→ race', async () => {
    await race(
      (w) => writeFile(w.fx, path.join(w.runDir, 'TAINTED'), '{}', { mode: 0o644 }),
      'race',
    );
    await race(async (w) => {
      await rename(w.fx, w.runDir, `${w.runDir}-old`);
      await mkdirp(w.fx, path.join(w.runDir, 'proposals'));
      await writeFile(w.fx, w.propFile, stringify(sessionJudged({ verdict: 'accept' })), {
        mode: 0o644,
      });
    }, 'race');
  });

  it('内容类失败路径同样做读后核对:坏 YAML / 非对象在读期间被换 → race(不是稳定的 invalid);不换仍是 invalid(正向对照)', async () => {
    for (const [bad, kind] of [
      ['a: [unclosed\n', 'yaml'],
      ['- a\n- b\n', 'not_object'],
    ] as const) {
      const w = await world({ proposal: bad });
      expect(await readOf(w)).toEqual({ kind: 'invalid', why: kind });
      const r = await readOf(w, {
        seam: {
          afterReads: () =>
            writeFile(w.fx, w.propFile, `${bad}# changed underneath\n`, { mode: 0o644 }),
        },
      });
      expect(r, kind).toEqual({ kind: 'unreadable', why: 'race' });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    '复核时文件 lstat 失败不是 ENOENT(EACCES)→ unreadable(recheck_io),不折叠成「没变」;规则确实缺失时仍是 rule = null(正向对照)',
    async () => {
      const w = await world({ rule: null });
      expect(await readOf(w)).toMatchObject({ kind: 'ok', rule: null });
      const rulesDir = path.join(w.runDir, 'rules', 'personal');
      try {
        const r = await readOf(w, { seam: { afterReads: () => chmod(w.fx, rulesDir, 0o600) } });
        expect(r).toEqual({ kind: 'unreadable', why: 'recheck_io' });
      } finally {
        await chmod(w.fx, rulesDir, 0o755);
      }
    },
  );

  it('目录被整体换走、子项原样挪回(子项身份不变)→ race:只有目录自身的身份核对能发现(run 目录 / reflect 目录各一)', async () => {
    await race(async (w) => {
      await rename(w.fx, w.runDir, `${w.runDir}-old`);
      await mkdirp(w.fx, w.runDir);
      await rename(
        w.fx,
        path.join(`${w.runDir}-old`, 'proposals'),
        path.join(w.runDir, 'proposals'),
      );
      await rename(w.fx, path.join(`${w.runDir}-old`, 'rules'), path.join(w.runDir, 'rules'));
    }, 'race');
    await race(async (w) => {
      await rename(w.fx, w.reflect, `${w.reflect}-old`);
      await mkdirp(w.fx, w.reflect);
      await rename(w.fx, path.join(`${w.reflect}-old`, RUN), path.join(w.reflect, RUN));
    }, 'race');
  });

  it('归属在读期间变化(第二次判定不再是采集中 / 读不出)→ 不返回 ok:前者 race,后者 attribution', async () => {
    const w = await world();
    let n = 0;
    const flip = await readOf(w, {
      attribution: async () => (++n === 1 ? P_ATTR : { staged: [], classify: () => 'P' }),
    });
    expect(flip).toEqual({ kind: 'unreadable', why: 'race' });
    let m = 0;
    const brokenSecond = await readOf(w, {
      attribution: async () => {
        if (++m === 2) throw new Error('counts gone');
        return P_ATTR;
      },
    });
    expect(brokenSecond).toEqual({ kind: 'unreadable', why: 'attribution' });
    expect(m).toBe(2);
  });

  it('预算:signal 已中止 → unreadable(timeout),且不读文件;读完后才中止同样 timeout', async () => {
    const w = await world();
    let attributed = 0;
    const r = await readOf(
      w,
      {
        attribution: async () => {
          attributed++;
          return P_ATTR;
        },
      },
      ctl({ aborted: true }),
    );
    expect(r).toEqual({ kind: 'unreadable', why: 'timeout' });
    expect(attributed).toBe(0);
    const c = new AbortController();
    const late = await source(w, { seam: { afterReads: () => c.abort() } }).read(RUN, PID, {
      signal: c.signal,
    });
    expect(late).toEqual({ kind: 'unreadable', why: 'timeout' });
  });

  it('经纯判定:读期间被换 → none / unreadable / indeterminate(增影响拒绝),不是 not_verified 也不是信号', async () => {
    const w = await world();
    const src = source(w, {
      seam: {
        afterReads: () =>
          writeFile(w.fx, w.propFile, `${stringify(sessionJudged({ verdict: 'accept' }))}# x\n`, {
            mode: 0o644,
          }),
      },
    });
    expect(await evaluateJudgeSignal(LINK, src, env)).toEqual({
      kind: 'none',
      reason: 'unreadable',
      display: 'invalid',
      growth: 'indeterminate',
      why: 'race',
    });
  });
});

describe('W9a 读适配器:零写入', () => {
  it('读成功 / 各类失败路径前后目录树逐字节相同、提案文件的 mtime / mode / inode 不变;对照:确有一次写入时树会变(快照不是空转)', async () => {
    const w = await world();
    const before = await treeOf(w.dir);
    const scenarios: (() => Promise<unknown>)[] = [
      () => readOf(w),
      () => readOf(w, { attribution: async () => ({ staged: [], classify: () => 'P' }) }),
      () => source(w).read(RUN, 'p1', ctl()),
      () => source(w).read('run-none', PID, ctl()),
      () => readOf(w, {}, ctl({ aborted: true })),
      () => readOf(w, { seam: { afterReads: () => undefined } }),
    ];
    for (const s of scenarios) await s();
    expect(await treeOf(w.dir)).toEqual(before);
    // 对照
    await writeFile(w.fx, path.join(w.dir, 'probe'), 'x', { mode: 0o644 });
    expect(await treeOf(w.dir)).not.toEqual(before);
    // 读不改 mtime / 不 chmod:提案文件的 stat 前后一致
    const a = await lstat(w.propFile);
    await readOf(w);
    const b = await lstat(w.propFile);
    expect([b.mtimeMs, b.mode, b.ino]).toEqual([a.mtimeMs, a.mode, a.ino]);
  });
});

// ---------------------------------------------------------------- 端口契约套件(适配器与内存参照实现同一份断言)

interface Spec {
  runDir: boolean;
  staged: boolean;
  tainted: boolean;
  /** 'absent' = 提案文件不存在;'bad_yaml';对象 = 提案内容 */
  proposal: 'absent' | 'bad_yaml' | Record<string, unknown>;
  rule: string | null;
}

/** 内存参照实现:按端口契约(失败分类)直接从 Spec 推出返回值,不碰文件系统 */
function modelSource(spec: Spec): ProposalJudgeSource {
  return {
    async read(_runId, _pid, c): Promise<JudgeSourceRead> {
      if (c.signal.aborted) return { kind: 'unreadable', why: 'timeout' };
      if (!spec.runDir) return { kind: 'run_gone' };
      if (spec.tainted || !spec.staged) return { kind: 'run_excluded' };
      if (spec.proposal === 'absent') return { kind: 'unreadable', why: 'proposal_missing' };
      if (spec.proposal === 'bad_yaml') return { kind: 'invalid', why: 'yaml' };
      return {
        kind: 'ok',
        proposal: spec.proposal,
        rule: spec.rule === null ? null : { target: TARGET, text: spec.rule },
      };
    },
  };
}

async function diskSource(spec: Spec): Promise<ProposalJudgeSource> {
  const w = await world({
    proposal:
      spec.proposal === 'absent'
        ? null
        : spec.proposal === 'bad_yaml'
          ? 'a: [unclosed\n'
          : stringify(spec.proposal),
    rule: spec.rule,
  });
  if (!spec.runDir) await remove(w.fx, w.runDir);
  if (spec.tainted) await writeFile(w.fx, path.join(w.runDir, 'TAINTED'), '{}', { mode: 0o644 });
  return source(w, {
    attribution: async () => ({ staged: spec.staged ? staged() : [], classify: () => 'P' }),
  });
}

const GOOD: Spec = {
  runDir: true,
  staged: true,
  tainted: false,
  proposal: JSON.parse(JSON.stringify(sessionJudged({ verdict: 'reject' }))) as Record<
    string,
    unknown
  >,
  rule: RULE_TEXT,
};

describe.each([
  ['生产适配器', diskSource],
  ['内存参照实现', async (s: Spec) => modelSource(s)],
] as const)('端口契约套件:%s', (_label, make) => {
  const kindOf = async (spec: Spec, c = ctl()): Promise<JudgeSourceRead> =>
    (await make(spec)).read(RUN, PID, c);

  it('采集中 + 提案 + 规则 → ok(提案对象与规则文本原样);没有规则 → ok 且 rule = null', async () => {
    const r = await kindOf(GOOD);
    expect(r).toMatchObject({ kind: 'ok', rule: { target: TARGET, text: RULE_TEXT } });
    expect(await kindOf({ ...GOOD, rule: null })).toMatchObject({ kind: 'ok', rule: null });
  });

  it('run 不在 → run_gone;被 taint / 不在采集中 → run_excluded;二者都不会是 ok', async () => {
    expect(await kindOf({ ...GOOD, runDir: false })).toEqual({ kind: 'run_gone' });
    expect(await kindOf({ ...GOOD, tainted: true })).toEqual({ kind: 'run_excluded' });
    expect(await kindOf({ ...GOOD, staged: false })).toEqual({ kind: 'run_excluded' });
  });

  it('采集中的 run 缺提案文件 → unreadable;YAML 损坏 → invalid(两类不得互换)', async () => {
    expect((await kindOf({ ...GOOD, proposal: 'absent' })).kind).toBe('unreadable');
    expect(await kindOf({ ...GOOD, proposal: 'bad_yaml' })).toMatchObject({ kind: 'invalid' });
  });

  it('signal 已中止 → unreadable(timeout)', async () => {
    expect(await kindOf(GOOD, ctl({ aborted: true }))).toEqual({
      kind: 'unreadable',
      why: 'timeout',
    });
  });

  it('同一份返回值经纯判定得到同一个结论(信号 / none 原因)', async () => {
    const sig = await evaluateJudgeSignal(LINK, await make(GOOD), env);
    expect(sig).toMatchObject({ kind: 'signal', verdict: 'reject' });
    const gone = await evaluateJudgeSignal(LINK, await make({ ...GOOD, runDir: false }), env);
    expect(gone).toMatchObject({ kind: 'none', reason: 'run_gone', growth: 'source_gone' });
    const missing = await evaluateJudgeSignal(
      LINK,
      await make({ ...GOOD, proposal: 'absent' }),
      env,
    );
    expect(missing).toMatchObject({ kind: 'none', reason: 'unreadable', growth: 'indeterminate' });
  });
});

describe('W9a 读适配器:对照常量', () => {
  it('personalProposal 的默认夹具与 LINK 对齐(防夹具漂移让上面的用例变空转)', () => {
    const p = personalProposal();
    expect([p.id, p.reflector.run_id, p.layer, p.targets]).toEqual([
      PID,
      RUN,
      'personal',
      [TARGET],
    ]);
  });
});

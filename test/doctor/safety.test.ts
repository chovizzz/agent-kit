/**
 * S5:doctor 的安全面——输出不泄漏(金丝雀)、零写入、零网络、真实 HOME 不被触碰、泄漏闸、用法与 JSON 形状。
 * 全部在 KIT_TMP 的假 HOME 上;唯一读真实 HOME 的用例只做只读列表比较。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCTOR_CHECK_IDS } from '../../src/contracts/doctor.js';
import { HOME_WRITE_TABLE } from '../../src/contracts/sync.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { getRealHome } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import {
  CANARY_USER,
  CODEX_MD,
  PI_MD,
  SHARED,
  STATE_PREFIX,
  chmodRel,
  fakeInstall,
  installed,
  newWorld,
  runDoctor,
  stdFixture,
  treeOf,
  writeUpdateState,
  type JsonReport,
  type World,
} from './world.js';

const CANARY_RE = /kit-canary/i;

/** 带用户既有内容与各种「想泄漏」素材的 HOME;路径里本身就有金丝雀「用户名」。 */
async function richWorld(): Promise<World> {
  const w = await installed('kit-canary-alice-');
  const codex = await w.read(CODEX_MD);
  await w.put(CODEX_MD, `# 我的规则 ${CANARY_USER}\n\n${codex}`);
  await w.put('.agents/skills/other/SKILL.md', `别人的 ${CANARY_USER}\n`);
  await w.put('.codex/AGENTS.override.md', `覆盖 ${CANARY_USER}\n`);
  await w.put('.pi/agent/AGENTS.override.md', `覆盖 ${CANARY_USER}\n`);
  await w.put('.config/agent-kit/config.toml', `[update]\npin = "kit-canary-pin"\n`);
  await w.put('.agents/skills/commit-checklist/EXTRA.md', `${CANARY_USER}\n`);
  await w.put(SHARED, `被改 ${CANARY_USER}\n`);
  await fakeInstall(w);
  await chmodRel(w, STATE_PREFIX, 0o700);
  return w;
}

describe('doctor:输出不泄漏', () => {
  it('文本与 --json:没有金丝雀文本、用户名、HOME / KIT_TMP / 仓库的绝对路径', async () => {
    const w = await richWorld();
    const overlay = path.join(w.dir, 'overlay.toml');
    await safe.writeFile(
      w.io,
      overlay,
      `sensitive_words = ["${CANARY_USER}"]\n[reflect]\negress = false\n`,
    );
    // 正向对照:金丝雀确实在被检查的文件里,且 doctor 确实看到了这些文件(D08 对 SHARED 之外的外来项有报告)
    expect(await readText(path.join(w.home, CODEX_MD))).toMatch(CANARY_RE);
    const forbidden = [w.home, w.dir, path.basename(w.dir), REPO_ROOT].filter((x) => x.length >= 4);
    for (const args of [[], ['--json'], ['--online'], ['--json', '--online']]) {
      const r = await runDoctor(w, args, { overlay });
      const all = r.out + r.err;
      expect(all.length).toBeGreaterThan(0);
      expect(all, args.join(' ')).not.toMatch(CANARY_RE);
      for (const f of forbidden) expect(all, `${args.join(' ')} 含 ${f}`).not.toContain(f);
      // 正向对照:输出里确实有受管相对路径(~/…),说明路径展示这条路径被走到了
      expect(r.out).toContain('~/.agents/skills/commit-checklist/SKILL.md');
      expect(r.out).toContain('D08');
    }
  });

  it('stdout 只含白名单字符:没有 CJK(用户内容多为中文)、没有 `/Users`、`/tmp`、`/private`', async () => {
    const w = await richWorld();
    const r = await runDoctor(w, ['--json']);
    expect(r.out).not.toMatch(/[㐀-鿿]/);
    expect(r.out).not.toMatch(/\/Users\/|\/tmp\/|\/private\/|\/var\//);
  });

  it('泄漏闸:结果里混进绝对路径 → 整份输出作废,退出 3', async () => {
    const w = await installed('leak-guard-');
    const r = await runDoctor(w, [], {
      deps: {
        mutateResults: (rs) => {
          rs[0]?.items.push(w.home);
        },
      },
    });
    expect(r.code).toBe(3);
    expect(r.out).toBe('');
    expect(r.err).toBe('DOCTOR_FAIL_CLOSED reason=output_leak\n');
  });

  it('同一状态连跑两次输出逐字节相同(确定性)', async () => {
    const w = await richWorld();
    const a = await runDoctor(w, ['--json']);
    const b = await runDoctor(w, ['--json']);
    expect(a.out).toBe(b.out);
    const t1 = await runDoctor(w, []);
    const t2 = await runDoctor(w, []);
    expect(t1.out).toBe(t2.out);
  });
});

describe('doctor:零写入', () => {
  it('已安装 + 杂项 HOME 上:前后快照(内容、权限、mtime、目录 mtime)零差异', async () => {
    const w = await richWorld();
    const before = await treeOf(w.dir);
    for (const args of [[], ['--json'], ['--online'], ['--only', 'D10', '--only', 'D05']]) {
      await runDoctor(w, args);
    }
    const after = await treeOf(w.dir);
    expect([...after.files]).toEqual([...before.files]);
    expect([...after.dirs]).toEqual([...before.dirs]);
    expect([...after.mtimes]).toEqual([...before.mtimes]);
    expect([...after.dirMtimes]).toEqual([...before.dirMtimes]);
  });

  it('空 HOME:不创建 ~/.local/state(也不创建 ~/.local、~/.config)', async () => {
    const w = await newWorld('zero-write-bare-');
    await w.setPayload(stdFixture());
    const before = await treeOf(w.home);
    const r = await runDoctor(w, []);
    expect([0, 1]).toContain(r.code);
    expect(r.out).toContain('doctor ok=');
    expect(await w.has('.local')).toBe(false);
    expect(await w.has('.config')).toBe(false);
    expect([...(await treeOf(w.home)).files]).toEqual([...before.files]);
    expect([...(await treeOf(w.home)).dirs]).toEqual([...before.dirs]);
  });

  it('仓库 .state 的冷却标记:过期标记也不被删除(doctor 不做清扫)', async () => {
    const w = await newWorld('zero-write-cool-');
    const stateDir = path.join(w.dir, 'repo-state');
    const dir = path.join(stateDir, 'llm-cooldown');
    await safe.mkdirp(w.io, dir);
    await safe.writeFile(w.io, path.join(dir, 'codex-20200101'), '');
    const before = await treeOf(stateDir);
    await runDoctor(w, [], { stateDir, noPayload: true });
    expect([...(await treeOf(stateDir)).files]).toEqual([...before.files]);
  });
});

describe('doctor:零网络', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('全局 fetch 被换成计数并抛错的探针:含 --online,调用 0 次', async () => {
    const calls: unknown[] = [];
    const probe = (...a: unknown[]): never => {
      calls.push(a);
      throw new Error('network forbidden');
    };
    vi.stubGlobal('fetch', probe);
    const w = await richWorld();
    for (const args of [[], ['--online'], ['--json', '--online']]) {
      const r = await runDoctor(w, args, {
        env: { HTTPS_PROXY: ['http:', '', [127, 0, 0, 1].join('.') + ':1'].join('/') },
      });
      expect([0, 1, 3, 4]).toContain(r.code);
      expect(r.out).toContain('D12');
    }
    expect(calls).toHaveLength(0);
    // 正向对照:探针本身有效
    expect(() => probe('x')).toThrow();
    expect(calls).toHaveLength(1);
  });

  const BAD_SPEC =
    /^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|worker_threads)$|(^|\/)io\/(net|home-fs|exec|llm-exec)(\.js)?$|^sigstore|^@sigstore/;

  /** 传递 import 闭包(忽略 `import type` / `export type`:类型导入编译后擦除) */
  async function closure(entries: string[]): Promise<{ seen: Set<string>; bad: string[] }> {
    const seen = new Set<string>();
    const bad: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = await readText(path.join(REPO_ROOT, rel));
      const specs = [
        ...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s+'([^']+)'/gm),
        ...src.matchAll(/^\s*import\s+'([^']+)'/gm),
        ...src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
      ].map((m) => m[1] as string);
      for (const spec of specs) {
        if (BAD_SPEC.test(spec)) bad.push(`${rel} -> ${spec}`);
        if (spec.startsWith('.')) {
          const target = path.normalize(path.join(path.dirname(rel), spec)).replace(/\.js$/, '.ts');
          if (await exists(path.join(REPO_ROOT, target))) await walk(target);
        }
      }
    };
    for (const e of entries) await walk(e);
    return { seen, bad };
  }

  it('doctor 的 import 闭包里没有 io/net、home-fs、safe-fs、exec、llm-exec、网络 / 子进程模块', async () => {
    const { seen, bad } = await closure([
      'src/commands/doctor.ts',
      'src/doctor/checks.ts',
      'src/doctor/collect.ts',
    ]);
    expect(seen.size).toBeGreaterThan(15); // 正向对照:闭包确实走了
    expect(seen.has('src/sync/snapshot.ts')).toBe(true);
    expect(seen.has('src/sync/plan.ts')).toBe(true);
    expect(bad).toEqual([]);
    // safe-fs(受 writeRoots 限制的既有写出口)只经 S4 既有链 payload-load → build/payload → render/out-layout 进入静态闭包;
    // doctor 自己的文件与其余模块都不引用它(行为上的零写入由本文件的快照用例证明)
    const SAFE_FS_IMPORT = /from\s+'(?:\.\.?\/)+(?:io\/)?safe-fs\.js'/;
    const importers: string[] = [];
    for (const f of seen) {
      if (SAFE_FS_IMPORT.test(await readText(path.join(REPO_ROOT, f)))) importers.push(f);
    }
    expect(importers).toEqual(['src/render/out-layout.ts']);
  });

  it('闭包检测器有效:同一个检测器能在 sync 命令(经 apply 引用 home-fs)里命中', async () => {
    const { bad } = await closure(['src/commands/sync.ts']);
    expect(bad.some((b) => /home-fs/.test(b))).toBe(true);
  });
});

/** 真实 HOME 受管路径的只读列表摘要(路径 + 类型 + 大小 + mtime),相当于 find … | sort | shasum */
async function realHomeDigest(home: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const abs = path.join(home, ...rel.split('/'));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      lines.push(`${rel} missing`);
      return;
    }
    lines.push(
      `${rel} ${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeMs}`,
    );
    if (st.isDirectory() && !st.isSymbolicLink() && depth < 6) {
      for (const e of await readDir(abs)) await walk(`${rel}/${e.name}`, depth + 1);
    }
  };
  for (const t of HOME_WRITE_TABLE) await walk(t.path.replace(/\/$/, ''), 0);
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

describe('doctor:真实 HOME', () => {
  it('对真实 HOME 跑一遍(默认零写入):命令正确执行,受管路径前后摘要一致', async () => {
    const w = await newWorld('real-home-');
    const real = getRealHome({});
    const before = await realHomeDigest(real);
    const r = await runDoctor(w, [], { noHome: true });
    const j = await runDoctor(w, ['--json'], { noHome: true });
    // 命令确实执行并给出汇总(不是因为用法错误提前退出)
    expect(r.code).not.toBe(2);
    expect(r.out).toMatch(/^doctor ok=\d+ warn=\d+ fail=\d+ n_a=\d+$/m);
    expect((JSON.parse(j.out) as JsonReport).checks).toHaveLength(16);
    expect(r.out + j.out).not.toContain(real);
    expect(await realHomeDigest(real)).toBe(before);
  });
});

describe('doctor:用法与输出形状', () => {
  it('用法错误:退出 2,stdout 为空,stderr 只有稳定码', async () => {
    const w = await installed('usage-');
    const cases: [string[], string][] = [
      [['--bogus'], 'unknown_arg'],
      [['extra'], 'unknown_arg'],
      [['--only', 'D99'], 'bad_check_id'],
      [['--only', 'd01'], 'bad_check_id'],
      [['--only'], 'unknown_arg'],
      [['--only', 'D01', '--only', 'X'], 'bad_check_id'],
    ];
    for (const [args, reason] of cases) {
      const r = await runDoctor(w, args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toBe(`DOCTOR_USAGE reason=${reason}\n`);
    }
  });

  it('--home 只收真实 HOME 或 KIT_TMP 之内:/etc 与 KIT_TMP 本身、相对路径都拒(退出 2)', async () => {
    const w = await installed('home-arg-');
    for (const h of ['/etc', w.env['KIT_TMP'] as string, 'relative/dir', '/nonexistent-dir-xyz']) {
      const r = await runDoctor(w, ['--home', h], { noHome: true });
      expect(r.code, h).toBe(2);
      expect(r.err).toBe('DOCTOR_USAGE reason=home_not_allowed\n');
      expect(r.out).toBe('');
    }
  });

  it('--only 可重复,按 id 升序输出且去重', async () => {
    const w = await installed('only-');
    const r = await runDoctor(w, ['--json', '--only', 'D05', '--only', 'D01', '--only', 'D05']);
    expect((JSON.parse(r.out) as JsonReport).checks.map((c) => c.id)).toEqual(['D01', 'D05']);
  });

  it('--json:canonical JSON,键集合固定;16 项齐全且按 id 排序', async () => {
    const w = await richWorld();
    const r = await runDoctor(w, ['--json']);
    const rep = JSON.parse(r.out) as JsonReport;
    expect(r.out).toBe(canonicalJson(rep));
    expect(Object.keys(rep).sort()).toEqual(['checks', 'schema_version', 'summary']);
    expect(Object.keys(rep.summary).sort()).toEqual(['fail', 'n_a', 'ok', 'warn']);
    expect(rep.checks.map((c) => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
    for (const c of rep.checks) {
      expect(Object.keys(c).sort()).toEqual(['counts', 'facts', 'id', 'items', 'result', 'status']);
      expect(['ok', 'warn', 'fail', 'n_a']).toContain(c.status);
      for (const v of Object.values(c.counts)) expect(Number.isInteger(v)).toBe(true);
    }
    // 同一检查在 ok / 非 ok 夹具下 facts 键集合不变(以 D05 / D14 为例)
    const clean = await installed('shape-clean-');
    const rep2 = JSON.parse((await runDoctor(clean, ['--json'])).out) as JsonReport;
    for (const id of ['D05', 'D06', 'D14', 'D04']) {
      const a = rep.checks.find((c) => c.id === id);
      const b = rep2.checks.find((c) => c.id === id);
      expect(Object.keys(a?.counts ?? {}).sort(), id).toEqual(Object.keys(b?.counts ?? {}).sort());
      expect(Object.keys(a?.facts ?? {}).sort(), id).toEqual(Object.keys(b?.facts ?? {}).sort());
    }
  });

  it('writeUpdateState 夹具有效:state.json 被 D12 读到(正向对照)', async () => {
    const w = await newWorld('shape-state-');
    await writeUpdateState(w, {
      schema_version: 1,
      max_seen_version: '1.2.3',
      installed: {
        version: '1.2.3',
        anchor: 'b'.repeat(64),
        installed_at: '2026-10-01T00:00:00.000Z',
      },
    });
    const rep = JSON.parse((await runDoctor(w, ['--json', '--only', 'D12'])).out) as JsonReport;
    expect(rep.checks[0]?.facts['max_seen_version']).toBe('1.2.3');
  });

  it('模块自检:PI_MD / CODEX_MD 常量与 HOME 写入表一致', () => {
    expect(HOME_WRITE_TABLE.some((t) => t.path === CODEX_MD)).toBe(true);
    expect(HOME_WRITE_TABLE.some((t) => t.path === PI_MD)).toBe(true);
  });
});

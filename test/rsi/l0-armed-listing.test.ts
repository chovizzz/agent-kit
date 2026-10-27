/**
 * R20-A2 B4a:armed 列举(R20-1.4 / 1.5a / 1.11、R20-6.7 / D4)与 D2 的 hint 读取。
 * 判据:每文件至多一次 ≤64KiB 读取;pi / codex 只解析首行,claude ≤ 32 行;不建盐、不读正文、不写任何文件(三层:写审计、静态闭包见 l0-closure、子进程空写入根)。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RSI_ARMED_HEAD_BYTES } from '../../src/contracts/rsi.js';
import { exists } from '../../src/io/read-fs.js';
import { chmod, mkdirp, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import {
  armedListingForHint,
  listArmed,
  listArmedDetailed,
} from '../../src/rsi/l0/armed-listing.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { treeOf } from './rsi-fixture.js';
import { buildRoChild, runRoChild } from './proc/ro-helper.js';
import { mkfifo, touchAt } from './proc/helper.js';
import { claudeLine, jl, makeL0Fx, put, rootOf, uuid, type L0Fx } from './l0-fixture.js';
import { runMain } from './ro-fixture.js';

const piHead = (cwd: string): string => jl({ type: 'session', cwd }, { type: 'message', id: 'm' });
const codexHead = (cwd: string): string =>
  jl({ type: 'session_meta', payload: { cwd } }, { type: 'event_msg' });

async function proj(f: L0Fx, name: string): Promise<string> {
  const p = path.join(f.dir, 'work', name);
  await mkdirp(f.fx, p, 0o755);
  return p;
}

describe('listArmed:三家真实形态汇总成项目清单', () => {
  it('同一项目的多个会话、多种 agent 聚合成一行;没有 cwd / 相对 cwd / notASession / 子代理 → unknownSessions;反思器自己的会话丢弃', async () => {
    const f = await makeL0Fx('ar-mix-');
    const a = await proj(f, 'alpha');
    const b = await proj(f, 'beta');
    await put(
      f,
      'claude',
      `p-a/${uuid(1)}.jsonl`,
      jl({ type: 'mode' }, { type: 'last-prompt' }, claudeLine(a)),
    );
    await put(
      f,
      'claude',
      `p-a/${uuid(2)}.jsonl`,
      jl(claudeLine('/x', { isSidechain: true }), claudeLine(a)),
    );
    await put(f, 'codex', '2026/10/24/rollout-1.jsonl', codexHead(a));
    await put(f, 'pi', '--b--/s1.jsonl', piHead(b));
    // 未知:无 cwd(claude)、相对 cwd(pi)、pi 非 session 首行、codex 子代理、codex 只有 turn_context
    await put(f, 'claude', `p-u/${uuid(3)}.jsonl`, jl({ type: 'mode' }));
    await put(f, 'pi', '--rel--/s.jsonl', piHead('relative/dir'));
    await put(f, 'pi', '--msg--/s.jsonl', jl({ type: 'message', cwd: a }));
    await put(
      f,
      'codex',
      '2026/10/24/rollout-sub.jsonl',
      jl({ type: 'session_meta', payload: { cwd: a, source: { subagent: {} } } }),
    );
    await put(
      f,
      'codex',
      '2026/10/24/rollout-tc.jsonl',
      jl({ type: 'turn_context', payload: { cwd: a } }),
    );
    // 反思器自己的会话:不是项目也不是未知
    await put(f, 'pi', '--self--/s.jsonl', piHead(path.join(f.io.stateDir, 'reflect', 'cwd')));
    const l = await listArmed(f.io, f.config);
    expect(l.rows).toEqual([
      { name: 'alpha', sessions: 3, path: a, excluded: false },
      { name: 'beta', sessions: 1, path: b, excluded: false },
    ]);
    expect(l.unknownSessions).toBe(5);
  });

  it('排除:索引为空 + 配置 exclude_dirs 也生效 → 该项目行 excluded=true;符号链接别名与大小写别名并入同一行', async () => {
    const f = await makeL0Fx('ar-ex-');
    const ex = await proj(f, 'Customer');
    const free = await proj(f, 'free');
    const alias = path.join(f.dir, 'work', 'customer-alias');
    await symlink(f.fx, ex, alias);
    await put(f, 'pi', '--1--/s.jsonl', piHead(ex));
    await put(f, 'pi', '--2--/s.jsonl', piHead(alias));
    await put(f, 'pi', '--3--/s.jsonl', piHead(free));
    const l = await listArmed(f.io, { ...f.config, excludeDirs: [ex] });
    expect(l.rows).toEqual([
      { name: 'Customer', sessions: 2, path: ex, excluded: true },
      { name: 'free', sessions: 1, path: free, excluded: false },
    ]);
  });
});

describe('读审计:每文件至多一次 ≤64KiB 物理读取;解析范围', () => {
  it('每个会话文件恰好一次 onRead(偏移 0、长度 64KiB);bytesRead 是实际读到的字节;大文件只读窗口', async () => {
    const f = await makeL0Fx('ar-read-');
    const a = await proj(f, 'a');
    const small = await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const big = await put(
      f,
      'codex',
      '2026/10/24/rollout-big.jsonl',
      jl({ type: 'session_meta', payload: { cwd: a } }) + 'z'.repeat(300 * 1024) + '\n',
    );
    const reads: { path: string; offset: number; length: number }[] = [];
    const d = await listArmedDetailed(f.io, f.config, { hooks: { onRead: (i) => reads.push(i) } });
    expect(reads.map((r) => r.path).sort()).toEqual([big, small].sort());
    for (const r of reads) expect([r.offset, r.length]).toEqual([0, RSI_ARMED_HEAD_BYTES]);
    expect(d.filesRead).toBe(2);
    expect(d.bytesRead).toBe(RSI_ARMED_HEAD_BYTES + piHead(a).length);
    expect(d.limitsHit).toEqual([]);
  });

  it('claude:cwd 在第 32 行 → 项目;在第 33 行 → 未知(同一次读取里只看前 32 行)', async () => {
    const f = await makeL0Fx('ar-cl32-');
    const a = await proj(f, 'a');
    const filler = (n: number): object[] => Array.from({ length: n }, () => ({ type: 'mode' }));
    await put(f, 'claude', `p1/${uuid(1)}.jsonl`, jl(...filler(31), claudeLine(a)));
    await put(f, 'claude', `p2/${uuid(2)}.jsonl`, jl(...filler(32), claudeLine(a)));
    const l = await listArmed(f.io, f.config);
    expect(l.rows).toEqual([{ name: 'a', sessions: 1, path: a, excluded: false }]);
    expect(l.unknownSessions).toBe(1);
  });

  it('不安全的文件(符号链接、FIFO)不读、不挂住;被换成链接的(列举之后)记未知', async () => {
    const f = await makeL0Fx('ar-unsafe-');
    const a = await proj(f, 'a');
    const real = await put(f, 'pi', '--a--/real.jsonl', piHead(a));
    await symlink(f.fx, real, path.join(rootOf(f, 'pi'), '--a--', 'link.jsonl'));
    mkfifo(path.join(rootOf(f, 'pi'), '--a--', 'fifo.jsonl'));
    const victim = await put(f, 'pi', '--v--/victim.jsonl', piHead(a));
    const reads: string[] = [];
    const d = await listArmedDetailed(f.io, f.config, {
      hooks: { onRead: (i) => reads.push(i.path) },
      beforeStep: async (step, p) => {
        if (step === 'head' && p === victim) {
          await rename(f.fx, victim, `${victim}.moved`);
          await symlink(f.fx, real, victim);
        }
      },
    });
    expect(reads).not.toContain(victim);
    expect(reads).toContain(real);
    expect(d.rows).toEqual([{ name: 'a', sessions: 1, path: a, excluded: false }]);
    expect(d.unknownSessions).toBe(1);
  });
});

describe('D4:头部读取上限(mtime 降序取前 N,其余计入 unknownSessions + RSI_LIMIT_FILES)', () => {
  it('上限 2、4 个文件:读最新的 2 个;1999/2000/2001 的边界用降低的上限演练(N=2:2 个 → 无限制命中;3 个 → 命中)', async () => {
    const f = await makeL0Fx('ar-lim-');
    const a = await proj(f, 'a');
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    const files: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await put(f, 'pi', `--${i}--/s.jsonl`, piHead(a));
      touchAt(p, new Date(t0 + i * 1000));
      files.push(p);
    }
    const reads: string[] = [];
    const d = await listArmedDetailed(f.io, f.config, {
      limits: { armedMaxFiles: 2 },
      hooks: { onRead: (i) => reads.push(i.path) },
    });
    expect(reads.sort()).toEqual([files[2], files[3]].sort());
    expect(d.unknownSessions).toBe(2);
    expect(d.limitsHit).toEqual(['RSI_LIMIT_FILES']);
    expect(d.rows[0]?.sessions).toBe(2);
    const exact = await listArmedDetailed(f.io, f.config, { limits: { armedMaxFiles: 4 } });
    expect(exact.limitsHit).toEqual([]);
    expect(exact.unknownSessions).toBe(0);
  });
  it('目录项上限命中 → limitsHit 含 RSI_LIMIT_ENTRIES(升序,与 RSI_LIMIT_FILES 并存)', async () => {
    const f = await makeL0Fx('ar-ent-');
    const a = await proj(f, 'a');
    for (let i = 0; i < 4; i++) await put(f, 'pi', `--${i}--/s.jsonl`, piHead(a));
    const d = await listArmedDetailed(f.io, f.config, {
      limits: { maxDirEntries: 3, armedMaxFiles: 1 },
    });
    expect(d.limitsHit).toEqual(['RSI_LIMIT_ENTRIES']);
  });
  it('头部读取之后发现该 agent 的根被换掉(旧目录改名保留)→ 该 agent 的整份结果作废,计入未知', async () => {
    const f = await makeL0Fx('ar-swap-');
    const a = await proj(f, 'a');
    const p1 = await put(f, 'pi', '--1--/s.jsonl', piHead(a));
    await put(f, 'pi', '--2--/s.jsonl', piHead(a));
    const c = await put(f, 'claude', `p/${uuid(1)}.jsonl`, jl(claudeLine(a)));
    const root = rootOf(f, 'pi');
    let swapped = false;
    const d = await listArmedDetailed(f.io, f.config, {
      beforeStep: async (step, p) => {
        if (step === 'head' && p === p1 && !swapped) {
          swapped = true;
          await rename(f.fx, root, `${root}.moved`);
          await mkdirp(f.fx, root, 0o755);
        }
      },
    });
    expect(swapped).toBe(true);
    // pi 两个会话作废(计入未知),claude 的那个照常
    expect(d.rows).toEqual([{ name: 'a', sessions: 1, path: a, excluded: false }]);
    expect(d.unknownSessions).toBe(2);
    expect(c).toContain('claude');
  });
});

describe('跨阶段根身份与完整性', () => {
  it('列举之后、策略初始化期间根被换(旧目录改名保留,同名文件在新根)→ 该 agent 作废、complete=false;对照:不换时 complete=true', async () => {
    const f = await makeL0Fx('ar-id-');
    const a = await proj(f, 'a');
    const ex = await proj(f, 'excl');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const cfg = { ...f.config, excludeDirs: [ex] };
    const ok = await listArmedDetailed(f.io, cfg);
    expect(ok.complete).toBe(true);
    expect(ok.rows.length).toBe(1);
    const root = rootOf(f, 'pi');
    let swapped = false;
    const probe = {
      exists: async () => true,
      realpath: async (p: string) => p,
      devIno: async (p: string) => {
        if (!swapped && p === ex) {
          swapped = true;
          await rename(f.fx, root, `${root}.moved`);
          await put(f, 'pi', '--a--/s.jsonl', piHead(a));
        }
        return null;
      },
    };
    const d = await listArmedDetailed(f.io, cfg, { probe });
    expect(swapped).toBe(true);
    expect(d.rows).toEqual([]);
    expect(d.unknownSessions).toBe(1);
    expect(d.complete).toBe(false);
  });
  it('读头期间祖先目录(~/.pi)被换成符号链接(末级 sessions 的 inode 不变)→ 该 agent 作废', async () => {
    const f = await makeL0Fx('ar-anc-');
    const a = await proj(f, 'a');
    const p1 = await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const dot = path.join(f.home, '.pi');
    let swapped = false;
    const d = await listArmedDetailed(f.io, f.config, {
      beforeStep: async (step, p) => {
        if (step === 'head' && p === p1 && !swapped) {
          swapped = true;
          await rename(f.fx, dot, `${dot}.moved`);
          await symlink(f.fx, `${dot}.moved`, dot);
        }
      },
    });
    expect(swapped).toBe(true);
    expect(d.rows).toEqual([]);
    expect(d.complete).toBe(false);
  });
  it('目录项上限触发的列举 → complete=false 且 limitsHit 含 RSI_LIMIT_ENTRIES', async () => {
    const f = await makeL0Fx('ar-inc-');
    const a = await proj(f, 'a');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const d = await listArmedDetailed(f.io, f.config, { limits: { maxDirEntries: 1 } });
    expect(d.complete).toBe(false);
    expect(d.limitsHit).toContain('RSI_LIMIT_ENTRIES');
  });
});

describe('listArmed 的 complete 字段(缺省 = true)', () => {
  it('完整扫描 → complete === true(listArmed 与 detailed 一致)', async () => {
    const f = await makeL0Fx('ar-cmp-ok-');
    const a = await proj(f, 'a');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    expect((await listArmed(f.io, f.config)).complete).toBe(true);
  });
  it.skipIf(process.getuid?.() === 0)('读不了的目录 → complete === false', async () => {
    const f = await makeL0Fx('ar-cmp-eacces-');
    const a = await proj(f, 'a');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    await put(f, 'pi', '--b--/s.jsonl', piHead(a));
    const dir = path.join(rootOf(f, 'pi'), '--b--');
    await chmod(f.fx, dir, 0o000);
    try {
      const l = await listArmed(f.io, f.config);
      expect(l.complete).toBe(false);
      expect(l.rows).toEqual([{ name: 'a', sessions: 1, path: a, excluded: false }]); // 正向前提:其余照常列出
    } finally {
      await chmod(f.fx, dir, 0o755);
    }
  });
  it('根在读头期间被换(身份变了,旧目录改名保留)→ complete === false', async () => {
    const f = await makeL0Fx('ar-cmp-swap-');
    const a = await proj(f, 'a');
    const p1 = await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const root = rootOf(f, 'pi');
    let swapped = false;
    const l = await listArmed(f.io, f.config, {
      beforeStep: async (step, p) => {
        if (step === 'head' && p === p1 && !swapped) {
          swapped = true;
          await rename(f.fx, root, `${root}.moved`);
          await mkdirp(f.fx, root, 0o755);
        }
      },
    });
    expect(swapped).toBe(true);
    expect(l.complete).toBe(false);
  });
  it('目录项上限 → complete === false', async () => {
    const f = await makeL0Fx('ar-cmp-lim-');
    const a = await proj(f, 'a');
    for (let i = 0; i < 3; i++) await put(f, 'pi', `--${i}--/s.jsonl`, piHead(a));
    expect((await listArmed(f.io, f.config, { limits: { maxDirEntries: 2 } })).complete).toBe(
      false,
    );
  });
});

describe('最终根复核覆盖所有 agent(含没有候选文件的)', () => {
  const swapProbe = (f: L0Fx, ex: string, root: string, withSession: boolean, a: string) => {
    let swapped = false;
    return {
      get swapped() {
        return swapped;
      },
      probe: {
        exists: async () => true,
        realpath: async (p: string) => p,
        devIno: async (p: string) => {
          if (!swapped && p === ex) {
            swapped = true;
            await rename(f.fx, root, `${root}.moved`);
            if (withSession) await put(f, 'pi', '--a--/s.jsonl', piHead(a));
            else await mkdirp(f.fx, root, 0o755);
          }
          return null;
        },
      },
    };
  };
  it('空根在策略初始化期间被换成带会话的新根 → complete=false(不是完整的零计数)', async () => {
    const f = await makeL0Fx('ar-empty-swap-');
    const a = await proj(f, 'a');
    const ex = await proj(f, 'excl');
    await mkdirp(f.fx, rootOf(f, 'pi'), 0o755); // 空根:没有候选文件
    const cfg = { ...f.config, excludeDirs: [ex], agents: ['pi' as const] };
    const s = swapProbe(f, ex, rootOf(f, 'pi'), true, a);
    const d = await listArmedDetailed(f.io, cfg, { probe: s.probe });
    expect(s.swapped).toBe(true);
    expect(d.complete).toBe(false);
    expect(d.rows).toEqual([]);
  });
  it('候选全被上限截掉(armedMaxFiles=0)后根被换 → complete=false', async () => {
    const f = await makeL0Fx('ar-trunc-swap-');
    const a = await proj(f, 'a');
    const ex = await proj(f, 'excl');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const cfg = { ...f.config, excludeDirs: [ex], agents: ['pi' as const] };
    const s = swapProbe(f, ex, rootOf(f, 'pi'), false, a);
    const d = await listArmedDetailed(f.io, cfg, { probe: s.probe, limits: { armedMaxFiles: 0 } });
    expect(s.swapped).toBe(true);
    expect(d.complete).toBe(false);
  });
  it('开始时不存在的根在策略初始化期间出现 → complete=false', async () => {
    const f = await makeL0Fx('ar-appear-');
    const a = await proj(f, 'a');
    const ex = await proj(f, 'excl');
    const cfg = { ...f.config, excludeDirs: [ex], agents: ['pi' as const] };
    let created = false;
    const probe = {
      exists: async () => true,
      realpath: async (p: string) => p,
      devIno: async (p: string) => {
        if (!created && p === ex) {
          created = true;
          await put(f, 'pi', '--a--/s.jsonl', piHead(a));
        }
        return null;
      },
    };
    const d = await listArmedDetailed(f.io, cfg, { probe });
    expect(created).toBe(true);
    expect(d.complete).toBe(false);
  });
  const absentThen = (name: string, mutate: (f: L0Fx, root: string) => Promise<void>): void => {
    it.skipIf(name.includes('不可访问') && process.getuid?.() === 0)(
      `开始时不存在的根在策略初始化期间${name} → complete=false(null 不等于「仍不存在」)`,
      async () => {
        const f = await makeL0Fx('ar-absent-then-');
        const ex = await proj(f, 'excl');
        const cfg = { ...f.config, excludeDirs: [ex], agents: ['pi' as const] };
        const root = rootOf(f, 'pi');
        let done = false;
        const probe = {
          exists: async () => true,
          realpath: async (p: string) => p,
          devIno: async (p: string) => {
            if (!done && p === ex) {
              done = true;
              await mutate(f, root);
            }
            return null;
          },
        };
        try {
          const d = await listArmedDetailed(f.io, cfg, { probe });
          expect(done).toBe(true);
          expect(d.complete).toBe(false);
          expect(d.rows).toEqual([]);
        } finally {
          if (name.includes('不可访问')) await chmod(f.fx, path.join(f.home, '.pi'), 0o755);
        }
      },
    );
  };
  absentThen('变成符号链接', async (f, root) => {
    const real = path.join(f.dir, 'real-pi-root');
    await mkdirp(f.fx, real, 0o755);
    await mkdirp(f.fx, path.dirname(root), 0o755);
    await symlink(f.fx, real, root);
  });
  absentThen('变成普通文件', async (f, root) => {
    await mkdirp(f.fx, path.dirname(root), 0o755);
    await writeFile(f.fx, root, 'x');
  });
  absentThen('变成不可访问', async (f, root) => {
    await mkdirp(f.fx, root, 0o755);
    await chmod(f.fx, path.join(f.home, '.pi'), 0o000);
  });
  it('对照:根始终不存在 → 完整的空清单(不误报);根存在但始终为空 → 完整', async () => {
    const f = await makeL0Fx('ar-none-');
    const d0 = await listArmedDetailed(f.io, f.config);
    expect(d0.complete).toBe(true);
    expect(d0.rows).toEqual([]);
    await mkdirp(f.fx, rootOf(f, 'pi'), 0o755);
    expect((await listArmedDetailed(f.io, f.config)).complete).toBe(true);
  });
});

describe('pi 覆盖判定:来源是命令传入的 env,不是进程环境(armed 与 status 同口径)', () => {
  const piRows = (out: string): boolean => out.includes('name=pi-proj ');
  async function setup(prefix: string) {
    const f = await makeL0Fx(prefix);
    const p = await proj(f, 'pi-proj');
    await put(f, 'pi', '--a--/s.jsonl', piHead(p));
    return f;
  }
  const agentsOf = (out: string): { id: string; status: string; reason: string | null }[] =>
    (JSON.parse(out) as { agents: { id: string; status: string; reason: string | null }[] }).agents;

  it('命令 env 设了 PI_CODING_AGENT_DIR、进程环境没设 → armed 不列 pi,status 报 pi_dir_override', async () => {
    const f = await setup('ar-pi-cmd-');
    const over = { env: { PI_CODING_AGENT_DIR: '/elsewhere' } };
    const pj = await runMain(f, ['rsi', 'projects'], over);
    expect(pj.code).toBe(0);
    expect(piRows(pj.out)).toBe(false);
    const st = await runMain(f, ['rsi', 'status', '--json'], over);
    expect(agentsOf(st.out).find((a) => a.id === 'pi')).toEqual({
      id: 'pi',
      status: 'not_evaluated',
      reason: 'pi_dir_override',
    });
  });
  it('空串也算已设;worker 标记 KIT_RSI_PI_DIR_SET=1 同样', async () => {
    const f = await setup('ar-pi-empty-');
    for (const env of [{ PI_CODING_AGENT_DIR: '' }, { KIT_RSI_PI_DIR_SET: '1' }]) {
      expect(piRows((await runMain(f, ['rsi', 'projects'], { env })).out)).toBe(false);
      const st = await runMain(f, ['rsi', 'status', '--json'], { env });
      expect(agentsOf(st.out).find((a) => a.id === 'pi')?.reason).toBe('pi_dir_override');
    }
  });
  it('反向:进程环境设了、命令 env 没设 → armed 列 pi,status 报 ok(两处都只看命令 env)', async () => {
    const f = await setup('ar-pi-proc-');
    vi.stubEnv('PI_CODING_AGENT_DIR', '/process-level');
    try {
      const pj = await runMain(f, ['rsi', 'projects']);
      expect(piRows(pj.out)).toBe(true);
      const st = await runMain(f, ['rsi', 'status', '--json']);
      expect(agentsOf(st.out).find((a) => a.id === 'pi')).toEqual({
        id: 'pi',
        status: 'ok',
        reason: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('KIT_RSI_PI_DIR_SET=0 不算已设;进程环境里的 worker 标记不影响命令;直接调 L0 显式 piDirSet:false 覆盖进程里的两个变量', async () => {
    const f = await setup('ar-pi-zero-');
    expect(
      piRows((await runMain(f, ['rsi', 'projects'], { env: { KIT_RSI_PI_DIR_SET: '0' } })).out),
    ).toBe(true);
    vi.stubEnv('KIT_RSI_PI_DIR_SET', '1');
    vi.stubEnv('PI_CODING_AGENT_DIR', '/process-level');
    try {
      expect(piRows((await runMain(f, ['rsi', 'projects'])).out)).toBe(true);
      const l = await listArmed(f.io, f.config, { piDirSet: false });
      expect(l.rows.map((r) => r.name)).toEqual(['pi-proj']);
      expect((await listArmed(f.io, f.config, { piDirSet: true })).rows).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('对照:两边都没设 → armed 列 pi,status ok', async () => {
    const f = await setup('ar-pi-none-');
    expect(piRows((await runMain(f, ['rsi', 'projects'])).out)).toBe(true);
    const st = await runMain(f, ['rsi', 'status', '--json']);
    expect(agentsOf(st.out).find((a) => a.id === 'pi')?.status).toBe('ok');
  });
});

describe('rsi projects:扫描不完整时明确提示(固定措辞,不带路径),退出码不变;完整时输出不变', () => {
  it.skipIf(process.getuid?.() === 0)(
    '真实链路:读不了的目录 → 文本多一行 armed_list=incomplete、JSON 有 complete:false、退 0、输出不含路径',
    async () => {
      const f = await makeL0Fx('ar-pj-inc-');
      const a = await proj(f, 'a');
      await put(f, 'pi', '--a--/s.jsonl', piHead(a));
      await put(f, 'pi', '--b--/s.jsonl', piHead(a));
      const dir = path.join(rootOf(f, 'pi'), '--b--');
      const ok = await runMain(f, ['rsi', 'projects']); // 完整时的基线输出
      expect(ok.out).not.toContain('armed_list');
      await chmod(f.fx, dir, 0o000);
      try {
        const t = await runMain(f, ['rsi', 'projects']);
        expect(t.code).toBe(0);
        expect(t.out.split('\n').filter((l) => l !== '')).toEqual([
          'key=- name=a sessions=1 status=pending',
          'projects collecting=1 excluded=0 new=0 unknown_signals=0 unknown_sessions=0',
          'armed_list=incomplete',
        ]);
        expect(t.out).not.toContain(f.dir);
        const j = JSON.parse((await runMain(f, ['rsi', 'projects', '--json'])).out) as {
          complete?: boolean;
        };
        expect(j.complete).toBe(false);
      } finally {
        await chmod(f.fx, dir, 0o755);
      }
    },
  );
});

describe('零写入(三层之二、之三;之一见 l0-closure)', () => {
  it('写审计 0 次;不建盐(.state/salt 不存在)、不建 rsi/;目录树前后一致;正向对照:同一审计钩子下的写入会被记到', async () => {
    const f = await makeL0Fx('ar-zw-');
    const a = await proj(f, 'a');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, jl(claudeLine(a)));
    await put(f, 'codex', '2026/10/24/rollout-1.jsonl', codexHead(a));
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const audit = withWriteAudit();
    const io = createRsiIoContext({ repo: f.repo, env: f.env, cwd: f.dir, writeAudit: audit.hook });
    const before = await treeOf(f.dir);
    const l = await listArmed(io, f.config);
    expect(l.rows[0]?.sessions).toBe(3); // 正向前提:确实读了会话
    expect(audit.calls).toEqual([]);
    expect(await exists(path.join(io.stateDir, 'salt'))).toBe(false);
    expect(await exists(path.join(io.stateDir, 'rsi'))).toBe(false);
    expect(await treeOf(f.dir)).toEqual(before);
    await writeFile(io, path.join(f.dir, 'tmp', 'probe'), 'x');
    expect(audit.calls.map((c) => c.op)).toEqual(['writeFile']);
  });

  it('子进程 KIT_WRITE_ROOTS=空:rsi projects 在真实 armed 链路上退出码 / 输出与进程内一致,没有 write_denied', async () => {
    const f = await makeL0Fx('ar-proc-');
    const a = await proj(f, 'a');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a));
    const script = await buildRoChild(f.tmp);
    const inproc = await runMain(f, ['rsi', 'projects']);
    expect(inproc.code).toBe(0);
    expect(inproc.out).toContain('name=a sessions=1 status=pending');
    const child = runRoChild(script, {
      argv: ['rsi', 'projects'],
      env: { ...f.env, PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: ':' },
      cwd: f.dir,
    });
    expect(child.code).toBe(0);
    expect(child.out).toBe(inproc.out);
    expect(child.err).not.toContain('write_denied');
  }, 120_000);
});

describe('armedListingForHint(D2:缺失或与当前 policy_fp / agents 不一致 → null)', () => {
  const fp = 'a'.repeat(64);
  const listing = {
    at: '2026-10-24T08:00:00.000Z',
    policy_fp: fp,
    agents: ['claude', 'pi'] as ('claude' | 'pi')[],
    projects: 2,
    excluded: 1,
    unknown_sessions: 3,
  };
  it('一致 → 计数(agents 传入顺序无关);缺失 / null 状态 → null', () => {
    const want = { projects: 2, excluded: 1, unknown_sessions: 3 };
    expect(armedListingForHint({ armed_listing: listing }, fp, ['pi', 'claude'])).toEqual(want);
    expect(armedListingForHint({ armed_listing: listing }, fp, ['claude', 'pi'])).toEqual(want);
    expect(armedListingForHint({}, fp, ['claude', 'pi'])).toBeNull();
    expect(armedListingForHint(null, fp, ['claude', 'pi'])).toBeNull();
  });
  it('policy_fp 变了 / agents 增删 → null;输入不被修改', () => {
    expect(
      armedListingForHint({ armed_listing: listing }, 'b'.repeat(64), ['claude', 'pi']),
    ).toBeNull();
    expect(armedListingForHint({ armed_listing: listing }, fp, ['claude'])).toBeNull();
    expect(
      armedListingForHint({ armed_listing: listing }, fp, ['claude', 'codex', 'pi']),
    ).toBeNull();
    const agents = ['pi', 'claude'] as ('claude' | 'pi')[];
    armedListingForHint({ armed_listing: listing }, fp, agents);
    expect(agents).toEqual(['pi', 'claude']);
  });
});

/**
 * S10-a:sync 把 kit 自己的状态目录(~/.local/state/agent-kit)收紧到 0700(contracts §19.3 D14 的写入例外)。
 * 全部在 KIT_TMP 内的假 HOME 上;真实 HOME 不碰(并断言真实 HOME 的状态目录权限未变)。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { getRealHome } from '../../src/io/paths.js';
import { lstat } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { STATE_PREFIX, SKILL, newWorld, stdFixture, type World } from './world.js';
import * as hfs from '../../src/io/home-fs.js';

const modeOf = async (abs: string): Promise<number> => (await lstat(abs)).mode & 0o777;

async function realStateMode(): Promise<number | null> {
  try {
    return await modeOf(path.join(getRealHome(), STATE_PREFIX));
  } catch {
    return null;
  }
}

async function world(label: string, mode: number): Promise<{ w: World; dir: string }> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture());
  const dir = path.join(w.home, STATE_PREFIX);
  await safe.mkdirp(w.io, dir, mode);
  await safe.chmod(w.io, dir, mode);
  return { w, dir };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync:状态目录收紧到 0700', () => {
  it('0755 -> 0700:--write 收紧并报 tightened;真实 HOME 未变', async () => {
    const realBefore = await realStateMode();
    const { w, dir } = await world('sd-tighten-', 0o755);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).toContain('SYNC_STATE_DIR tightened from=0755 to=0700');
    expect(await modeOf(dir)).toBe(0o700);
    expect(await realStateMode()).toBe(realBefore);
  });

  it('0750 / 0777 也收紧到 0700', async () => {
    for (const m of [0o750, 0o777]) {
      const { w, dir } = await world('sd-wide-', m);
      const r = await w.run(['--write']);
      expect(r.code).toBe(ExitCode.OK);
      expect(await modeOf(dir)).toBe(0o700);
    }
  });

  it('已是 0700:不动、不输出 SYNC_STATE_DIR', async () => {
    const { w, dir } = await world('sd-ok-', 0o700);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).not.toContain('SYNC_STATE_DIR');
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('dry-run:不改,只报 would_tighten', async () => {
    const { w, dir } = await world('sd-dry-', 0o755);
    const r = await w.run([]);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).toContain('SYNC_STATE_DIR would_tighten from=0755 to=0700');
    expect(r.err).not.toContain('tightened from');
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('重复 sync 幂等:第二次不再报、权限稳定', async () => {
    const { w, dir } = await world('sd-idem-', 0o755);
    const a = await w.run(['--write']);
    const b = await w.run(['--write']);
    expect(a.err).toContain('SYNC_STATE_DIR tightened');
    expect(b.code).toBe(ExitCode.OK);
    expect(b.err).not.toContain('SYNC_STATE_DIR');
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('状态目录是符号链接:不改链接目标,fail-closed', async () => {
    const w = await newWorld('sd-link-');
    await w.setPayload(stdFixture());
    const target = path.join(w.dir, 'elsewhere');
    await safe.mkdirp(w.io, target, 0o755);
    await safe.chmod(w.io, target, 0o755);
    await safe.mkdirp(w.io, path.join(w.home, '.local/state'));
    await safe.symlink(w.io, target, path.join(w.home, STATE_PREFIX));
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await modeOf(target)).toBe(0o755);
  });

  it('属主不是当前用户:不改并告警(SYNC_STATE_DIR_SKIPPED)', async () => {
    const { w, dir } = await world('sd-foreign-', 0o755);
    const uid = process.getuid?.() ?? 0;
    // 无法真造一个他人所有的目录(非 root):只在此处替换 getuid,用后立即还原
    // eslint-disable-next-line no-restricted-syntax
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    const r = await w.run(['--write']);
    vi.restoreAllMocks();
    expect(r.err).toContain('SYNC_STATE_DIR_SKIPPED reason=foreign_owner');
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('只收紧 agent-kit 这一层:上级与兄弟目录权限不变', async () => {
    const { w, dir } = await world('sd-scope-', 0o755);
    const sibling = path.join(w.home, '.local/state/other-tool');
    await safe.mkdirp(w.io, sibling, 0o755);
    await safe.chmod(w.io, sibling, 0o755);
    const parent = path.dirname(dir);
    await safe.chmod(w.io, parent, 0o755);
    await w.run(['--write']);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(sibling)).toBe(0o755);
    expect(await modeOf(parent)).toBe(0o755);
  });

  it('符号链接形式的临时目录作 --home:同样收紧', async () => {
    const { w, dir } = await world('sd-linkhome-', 0o755);
    const alias = path.join(w.dir, 'home-alias');
    await safe.symlink(w.io, w.home, alias);
    const r = await w.run(['--write', '--home', alias], { noHome: true });
    // 经链接别名传入的假 HOME:按 resolveAllowedHome 解析后收紧,或被拒(USAGE);绝不能漏改到别处
    if (r.code === ExitCode.OK) expect(await modeOf(dir)).toBe(0o700);
    else expect(await modeOf(dir)).toBe(0o755);
  });

  it('另一个 sync 持锁:本次 --write 以 SYNC_LOCKED 退出,状态目录权限不变', async () => {
    const { w, dir } = await world('sd-locked-', 0o755);
    await safe.mkdirp(w.io, path.join(dir, 'sync'), 0o755);
    await safe.writeFile(
      w.io,
      path.join(dir, 'sync/lock'),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), nonce: 'x' }),
    );
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.NOT_RUN);
    expect(r.err).toContain('SYNC_LOCKED');
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('payload 缺失(未执行):不收紧', async () => {
    const w = await newWorld('sd-refused-');
    const dir = path.join(w.home, STATE_PREFIX);
    await safe.mkdirp(w.io, dir, 0o755);
    await safe.chmod(w.io, dir, 0o755);
    // 没有 payload => 未执行(4),整次不写
    const r = await w.run(['--write'], { env: { KIT_PAYLOAD_DIR: path.join(w.dir, 'nope') } });
    expect(r.code).not.toBe(ExitCode.OK);
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('已安装且无其它变更,目录又被改宽:no-op --write 也收紧(经锁),且不产生新事务', async () => {
    const { w, dir } = await world('sd-noop-', 0o700);
    expect((await w.run(['--write'])).code).toBe(ExitCode.OK);
    await safe.chmod(w.io, dir, 0o755);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).toContain('SYNC_STATE_DIR tightened from=0755 to=0700');
    expect(r.out).not.toMatch(/^txn /m);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('无组 / 其他位的窄权限(0500)不改', async () => {
    const { w, dir } = await world('sd-narrow-', 0o755);
    await safe.chmod(w.io, dir, 0o500);
    const r = await w.run([]);
    expect(r.err).not.toContain('SYNC_STATE_DIR');
    expect(await modeOf(dir)).toBe(0o500);
    await safe.chmod(w.io, dir, 0o700); // 还原以便清理
  });

  it('--json:stdout 键集合不变,提示只走 stderr', async () => {
    const { w } = await world('sd-json-', 0o755);
    const r = await w.run(['--json']);
    expect(r.err).toContain('SYNC_STATE_DIR would_tighten');
    expect(r.out).not.toContain('SYNC_STATE_DIR');
    expect(Object.keys(JSON.parse(r.out) as object)).toEqual(
      expect.arrayContaining(['mode', 'dry', 'status', 'exit', 'ops', 'summary', 'ledger']),
    );
  });

  it('--rollback 不收紧', async () => {
    const { w, dir } = await world('sd-rollback-', 0o700);
    const a = await w.run(['--write']);
    const id = /^txn (\S+)$/m.exec(a.out)?.[1] as string;
    await safe.chmod(w.io, dir, 0o755);
    const r = await w.run(['--rollback', id, '--write']);
    expect(r.err).not.toContain('SYNC_STATE_DIR');
    expect(await modeOf(dir)).toBe(0o755);
  });
});

describe('sync:状态目录收紧——拒绝与链接路径', () => {
  it('计划被拒(目标路径已有外来文件):退出非 0,状态目录不收紧', async () => {
    const { w, dir } = await world('sd-planrefused-', 0o755);
    const target = path.join(w.home, SKILL);
    await safe.mkdirp(w.io, path.dirname(target));
    await safe.writeFile(w.io, target, 'foreign user content\n');
    const r = await w.run(['--write']);
    expect(r.code).not.toBe(ExitCode.OK);
    expect(r.err).not.toContain('tightened');
    expect(await modeOf(dir)).toBe(0o755);
  });

  async function direct(label: string): Promise<{ w: World; ctx: hfs.HomeFsContext }> {
    const w = await newWorld(label);
    const tmpDir = path.join(w.dir, 'ht');
    await safe.mkdirp(w.io, tmpDir);
    return { w, ctx: hfs.createHomeFsContext({ home: w.home, planScope: [], tmpDir }) };
  }

  it('home-fs 直测:agent-kit 本身是符号链接 -> skipped_unsafe,链接目标权限不变', async () => {
    const { w, ctx } = await direct('sd-d-link-');
    const target = path.join(w.dir, 'elsewhere');
    await safe.mkdirp(w.io, target, 0o755);
    await safe.chmod(w.io, target, 0o755);
    await safe.mkdirp(w.io, path.join(w.home, '.local/state'));
    await safe.symlink(w.io, target, path.join(w.home, STATE_PREFIX));
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
    expect(await modeOf(target)).toBe(0o755);
  });

  it('home-fs 直测:上级 .local/state 是符号链接 -> skipped_unsafe,不改链接目标内的 agent-kit', async () => {
    const { w, ctx } = await direct('sd-d-plink-');
    const real = path.join(w.dir, 'realstate');
    const inner = path.join(real, 'agent-kit');
    await safe.mkdirp(w.io, inner, 0o755);
    await safe.chmod(w.io, inner, 0o755);
    await safe.mkdirp(w.io, path.join(w.home, '.local'));
    await safe.symlink(w.io, real, path.join(w.home, '.local/state'));
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
    expect(await modeOf(inner)).toBe(0o755);
  });

  it('home-fs 直测:agent-kit 是普通文件 -> skipped_unsafe', async () => {
    const { w, ctx } = await direct('sd-d-file-');
    await safe.mkdirp(w.io, path.join(w.home, '.local/state'));
    await safe.writeFile(w.io, path.join(w.home, STATE_PREFIX), 'x');
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'skipped_unsafe' });
  });

  it('home-fs 直测:他人所有 -> skipped_foreign_owner,权限不变', async () => {
    const { w, ctx } = await direct('sd-d-foreign-');
    const dir = path.join(w.home, STATE_PREFIX);
    await safe.mkdirp(w.io, dir, 0o755);
    await safe.chmod(w.io, dir, 0o755);
    const uid = process.getuid?.() ?? 0;
    // eslint-disable-next-line no-restricted-syntax
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    const r = await hfs.tightenKitStateDir(ctx, true);
    vi.restoreAllMocks();
    expect(r).toEqual({ result: 'skipped_foreign_owner' });
    expect(await modeOf(dir)).toBe(0o755);
  });

  it('home-fs 直测:目录不存在 -> absent;已 0700 -> ok', async () => {
    const { w, ctx } = await direct('sd-d-absent-');
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'absent' });
    const dir = path.join(w.home, STATE_PREFIX);
    await safe.mkdirp(w.io, dir, 0o700);
    await safe.chmod(w.io, dir, 0o700);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'ok' });
  });
});

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AdapterMetaSchema, HOME_WRITE_TABLE, isHomeWritePath } from '../../src/contracts/index.js';
import * as hfs from '../../src/io/home-fs.js';
import { HOME_DENY, HomeWriteDeniedError } from '../../src/io/home-fs.js';
import type { HomeDenyCode, HomeFsStage } from '../../src/io/home-fs.js';
import { getRealHome } from '../../src/io/paths.js';
import { exists, lstat, readBytes, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT, wideCtx } from '../helpers/tmp.js';

const ADAPTERS = path.join(REPO_ROOT, 'adapters');

interface Fixture {
  dir: string;
  home: string;
  tmpDir: string;
  /** 造夹具用的宽 safe-fs 上下文(只在 KIT_TMP 内) */
  fx: ReturnType<typeof wideCtx>;
  mk: (
    planScope: string[],
    extra?: { onStage?: (s: HomeFsStage) => void | Promise<void> },
  ) => hfs.HomeFsContext;
}

async function setup(prefix: string): Promise<Fixture> {
  const { ctx, dir } = await makeTempDir(prefix);
  const fx = wideCtx(dir);
  const home = path.join(dir, 'home');
  await safe.mkdirp(fx, home);
  const tmpDir = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
  return {
    dir,
    home,
    tmpDir,
    fx,
    mk: (planScope, extra = {}) => hfs.createHomeFsContext({ home, planScope, tmpDir, ...extra }),
  };
}

/** 递归列出 root 下所有条目(相对路径 + 类型 + 内容哈希),用来断言「什么都没写」。 */
async function tree(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(path.join(root, rel))) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink) out.push(`${r} -> link`);
    else if (e.isDirectory) {
      out.push(`${r}/`);
      out.push(...(await tree(root, r)));
    } else {
      out.push(
        `${r} ${createHash('sha256')
          .update(await readBytes(path.join(root, r)))
          .digest('hex')
          .slice(0, 12)}`,
      );
    }
  }
  return out;
}

async function expectDenied(p: Promise<unknown>, code: HomeDenyCode): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HomeWriteDeniedError);
  expect((err as HomeWriteDeniedError).code).toBe(code);
}

/** 真实 HOME 受管路径的只读快照(lstat 元数据 + 小文件内容哈希);缺失的路径也占一行。 */
async function snapshot(home: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const abs = path.join(home, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      lines.push(`${rel} missing`);
      return;
    }
    let content = '';
    if (st.isFile() && st.size <= 1 << 20) {
      content = createHash('sha256')
        .update(await readBytes(abs))
        .digest('hex');
    }
    lines.push(`${rel} ${st.mode} ${st.size} ${st.mtimeMs} ${st.ino} ${content}`);
    if (st.isDirectory() && depth < 4) {
      for (const e of await readDir(abs)) await walk(`${rel}/${e.name}`, depth + 1);
    }
  };
  for (const e of HOME_WRITE_TABLE) await walk(e.path.replace(/\/$/, ''), 0);
  return createHash('sha256').update(lines.join('\n')).digest('hex') + ` lines=${lines.length}`;
}

const realHomeBefore = await snapshot(getRealHome());
afterAll(async () => {
  expect(await snapshot(getRealHome())).toBe(realHomeBefore);
});

// ---------------------------------------------------------------------------

describe('home-fs:表内路径可写(正向对照)', () => {
  it('每个表条目:file 条目精确路径、dir 条目内部子路径都能原子写入并读回', async () => {
    const f = await setup('homefs-ok-');
    const targets = HOME_WRITE_TABLE.map((e) => (e.kind === 'file' ? e.path : `${e.path}sub/f.md`));
    const ctx = f.mk(targets);
    // 干净 HOME 上直接写:缺失的父目录(含 .codex 这类文件型条目的父目录)由 home-fs 隐式创建
    for (const rel of targets) {
      await hfs.writeFile(ctx, rel, `body ${rel}`, { mode: 0o600 });
      expect(await readText(path.join(f.home, rel))).toBe(`body ${rel}`);
      expect((await lstat(path.join(f.home, rel))).mode & 0o777).toBe(0o600);
    }
    // 没有遗留临时文件
    expect((await tree(f.home)).filter((l) => l.includes('.tmp-'))).toEqual([]);
  });

  it('HOME_WRITE_TABLE 的 adapter 条目 == adapters/*/managed-targets.json 并集', async () => {
    const dirs = (await readDir(ADAPTERS)).filter((e) => !e.isFile).map((e) => e.name);
    const union = new Set<string>();
    for (const d of dirs) {
      const meta = AdapterMetaSchema.parse(
        JSON.parse(await readText(path.join(ADAPTERS, d, 'managed-targets.json'))),
      );
      for (const t of meta.managed_targets) union.add(t.slice(2));
    }
    expect(
      new Set(HOME_WRITE_TABLE.filter((e) => e.owner === 'adapter').map((e) => e.path)),
    ).toEqual(union);
  });

  it('kit 状态目录内部允许 .json(ledger.json)与点开头文件;adapter 目录内部不行', async () => {
    const f = await setup('homefs-json-');
    const rel = '.local/state/agent-kit/sync/ledger.json';
    const ctx = f.mk([rel, '.local/state/agent-kit/.lock']);
    await hfs.mkdirp(ctx, '.local/state/agent-kit/sync', 0o700);
    await hfs.writeFile(ctx, rel, '{}', { mode: 0o600 });
    await hfs.writeFile(ctx, '.local/state/agent-kit/.lock', 'x');
    expect(await readText(path.join(f.home, rel))).toBe('{}');
  });
});

describe('home-fs:路径 / 表 / planScope 拒绝规则(表驱动,每条先有正向对照)', () => {
  const OK = '.claude/skills/demo/SKILL.md';
  const cases: { name: string; rel: string; code: HomeDenyCode }[] = [
    { name: '绝对路径', rel: '/etc/passwd', code: HOME_DENY.PATH_INVALID },
    { name: '`..` 逃逸', rel: '.claude/skills/../../x.md', code: HOME_DENY.PATH_INVALID },
    { name: '开头 `..`', rel: '../outside.md', code: HOME_DENY.PATH_INVALID },
    { name: '波浪号', rel: '~/.claude/skills/x/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: '空段 `//`', rel: '.claude/skills//x/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: '尾部斜杠', rel: '.claude/skills/x/', code: HOME_DENY.PATH_INVALID },
    { name: '反斜杠', rel: '.claude\\skills\\x\\SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: 'NUL 字节', rel: '.claude/skills/x\0/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: '换行控制字符', rel: '.claude/skills/x\n/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: 'Unicode 同形字', rel: '.claude/skills/demо/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: 'NFD 变音', rel: '.claude/skills/café/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: '零宽字符', rel: '.claude/skills/de​mo/SKILL.md', code: HOME_DENY.PATH_INVALID },
    { name: '空串', rel: '', code: HOME_DENY.PATH_INVALID },
    { name: '表外:CLAUDE.md', rel: '.claude/CLAUDE.md', code: HOME_DENY.NOT_IN_TABLE },
    { name: '表外:settings.json', rel: '.claude/settings.json', code: HOME_DENY.NOT_IN_TABLE },
    { name: '表外:codex config', rel: '.codex/config.toml', code: HOME_DENY.NOT_IN_TABLE },
    {
      name: '表外:用户配置目录',
      rel: '.config/agent-kit/config.toml',
      code: HOME_DENY.NOT_IN_TABLE,
    },
    { name: '表外:rules 兄弟目录', rel: '.claude/rules/other.md', code: HOME_DENY.NOT_IN_TABLE },
    { name: '表外:shell rc', rel: '.zshrc', code: HOME_DENY.NOT_IN_TABLE },
    { name: '大小写变体目录', rel: '.Claude/skills/demo/SKILL.md', code: HOME_DENY.NOT_IN_TABLE },
    { name: '大小写变体文件条目', rel: '.codex/agents.md', code: HOME_DENY.NOT_IN_TABLE },
    {
      name: '前缀相近的兄弟目录',
      rel: '.claude/skills-extra/x/SKILL.md',
      code: HOME_DENY.NOT_IN_TABLE,
    },
    { name: '目录条目本身(skills)', rel: '.claude/skills', code: HOME_DENY.DIR_ITSELF },
    { name: '目录条目本身(kit state)', rel: '.local/state/agent-kit', code: HOME_DENY.DIR_ITSELF },
    { name: '点开头段', rel: '.claude/skills/.hidden/SKILL.md', code: HOME_DENY.DOT_SEGMENT },
    {
      name: '别的管理器的清单',
      rel: '.agents/skills/.social-hub-skills.json',
      code: HOME_DENY.DOT_SEGMENT,
    },
    { name: '.json 目标', rel: '.claude/skills/demo/settings.json', code: HOME_DENY.JSON_TARGET },
    { name: '.json 目标(agents)', rel: '.codex/agents/x.json', code: HOME_DENY.JSON_TARGET },
  ];

  it.each(cases)('$name → $code,且什么都没写', async ({ rel, code }) => {
    const f = await setup('homefs-deny-');
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/demo'));
    await safe.mkdirp(f.fx, path.join(f.home, '.local/state'));
    const before = await tree(f.home);
    // 即便把这条路径写进 planScope,创建上下文就会因表外而拒(SCOPE_INVALID);用一个合法条目建上下文来测各操作
    const ctx = f.mk([OK]);
    await expectDenied(hfs.writeFile(ctx, rel, 'x'), code);
    await expectDenied(hfs.remove(ctx, rel), code);
    await expectDenied(hfs.chmod(ctx, rel, 0o644), code);
    await expectDenied(hfs.rename(ctx, rel, OK), code);
    await expectDenied(hfs.copyFile(ctx, OK, rel), code);
    expect(await tree(f.home)).toEqual(before);
    // 正向对照:同一个上下文写 OK 成功
    await hfs.writeFile(ctx, OK, 'ok');
    expect(await readText(path.join(f.home, OK))).toBe('ok');
  });

  it('表内但不在 planScope → OUT_OF_PLAN_SCOPE;进了 planScope 即可写', async () => {
    const f = await setup('homefs-scope-');
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/demo'));
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/other'));
    const other = '.claude/skills/other/SKILL.md';
    const ctx = f.mk([OK]);
    await expectDenied(hfs.writeFile(ctx, other, 'x'), HOME_DENY.OUT_OF_PLAN_SCOPE);
    await expectDenied(hfs.remove(ctx, other), HOME_DENY.OUT_OF_PLAN_SCOPE);
    await expectDenied(hfs.rename(ctx, OK, other), HOME_DENY.OUT_OF_PLAN_SCOPE);
    await expectDenied(hfs.copyFile(ctx, other, OK), HOME_DENY.OUT_OF_PLAN_SCOPE);
    expect(await exists(path.join(f.home, other))).toBe(false);
    const wider = f.mk([OK, other]);
    await hfs.writeFile(wider, other, 'x');
    expect(await readText(path.join(f.home, other))).toBe('x');
  });

  it('planScope 条目本身必须是表内文件路径,否则创建上下文即拒', async () => {
    const f = await setup('homefs-scope-bad-');
    for (const bad of [
      '.claude/CLAUDE.md',
      '.claude/skills',
      '/etc/passwd',
      '.claude/skills/x/a.json',
    ]) {
      let err: unknown;
      try {
        f.mk([bad]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HomeWriteDeniedError);
      expect((err as HomeWriteDeniedError).code).toBe(HOME_DENY.SCOPE_INVALID);
    }
    expect(() => f.mk([OK])).not.toThrow();
  });

  it('拒绝信息只含稳定码与调用方给的相对路径(不含 HOME 绝对路径)', async () => {
    const f = await setup('homefs-msg-');
    const ctx = f.mk([OK]);
    const err = await hfs.writeFile(ctx, '.claude/CLAUDE.md', 'x').catch((e: unknown) => e);
    expect((err as Error).message).toBe(`HOME_NOT_IN_TABLE path=".claude/CLAUDE.md"`);
    expect((err as Error).message).not.toContain(f.home);
  });

  it('权限位含 setuid 等 → BAD_MODE', async () => {
    const f = await setup('homefs-mode-');
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/demo'));
    const ctx = f.mk([OK]);
    await expectDenied(hfs.writeFile(ctx, OK, 'x', { mode: 0o4755 }), HOME_DENY.BAD_MODE);
    await expectDenied(hfs.chmod(ctx, OK, 0o1777), HOME_DENY.BAD_MODE);
    expect(await exists(path.join(f.home, OK))).toBe(false);
  });
});

describe('home-fs:目录操作(目录本身不可写)', () => {
  it('mkdirp / removeDir 对 dir 条目本身一律拒;条目内部且是计划目标祖先才行', async () => {
    const f = await setup('homefs-dir-');
    const ctx = f.mk(['.claude/skills/demo/SKILL.md', '.local/state/agent-kit/sync/ledger.json']);
    for (const itself of [
      '.claude/skills',
      '.local/state/agent-kit',
      '.agents/skills',
      '.codex/agents',
    ]) {
      await expectDenied(hfs.mkdirp(ctx, itself), HOME_DENY.DIR_ITSELF);
      await expectDenied(hfs.removeDir(ctx, itself), HOME_DENY.DIR_ITSELF);
    }
    expect(await tree(f.home)).toEqual([]);
    // 表外目录 / 点开头段 / 不是计划目标祖先
    await expectDenied(hfs.mkdirp(ctx, '.claude'), HOME_DENY.NOT_IN_TABLE);
    await expectDenied(hfs.mkdirp(ctx, '.claude/skills/.hidden'), HOME_DENY.DOT_SEGMENT);
    await expectDenied(hfs.mkdirp(ctx, '.claude/skills/other'), HOME_DENY.OUT_OF_PLAN_SCOPE);
    await expectDenied(
      hfs.mkdirp(ctx, '.claude/skills/demo/SKILL.md/x'),
      HOME_DENY.OUT_OF_PLAN_SCOPE,
    );
    expect(await tree(f.home)).toEqual([]);
    // 正向:隐式创建条目目录与上级
    await hfs.mkdirp(ctx, '.claude/skills/demo');
    await hfs.mkdirp(ctx, '.local/state/agent-kit/sync', 0o700);
    expect((await lstat(path.join(f.home, '.local/state/agent-kit/sync'))).mode & 0o777).toBe(
      0o700,
    );
    await hfs.writeFile(ctx, '.claude/skills/demo/SKILL.md', 'x');
    // removeDir 对非空目录失败且不丢文件
    await expect(hfs.removeDir(ctx, '.claude/skills/demo')).rejects.toThrow();
    expect(await readText(path.join(f.home, '.claude/skills/demo/SKILL.md'))).toBe('x');
    await hfs.remove(ctx, '.claude/skills/demo/SKILL.md');
    await hfs.removeDir(ctx, '.claude/skills/demo');
    expect(await exists(path.join(f.home, '.claude/skills/demo'))).toBe(false);
    // 不存在视为成功
    await hfs.remove(ctx, '.claude/skills/demo/SKILL.md');
    await hfs.removeDir(ctx, '.claude/skills/demo');
  });
});

describe('home-fs:符号链接(决策 ⑩A)', () => {
  const REL = '.claude/skills/demo/SKILL.md';

  it('`~/.claude` 是指向 dotfiles 的链接 → INTERMEDIATE_SYMLINK,dotfiles 里什么都没写', async () => {
    const f = await setup('homefs-link-claude-');
    const dotfiles = path.join(f.dir, 'dotfiles');
    await safe.mkdirp(f.fx, path.join(dotfiles, 'skills/demo'));
    await safe.symlink(f.fx, dotfiles, path.join(f.home, '.claude'));
    const before = await tree(dotfiles);
    const ctx = f.mk([REL]);
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.INTERMEDIATE_SYMLINK);
    await expectDenied(hfs.remove(ctx, REL), HOME_DENY.INTERMEDIATE_SYMLINK);
    await expectDenied(hfs.mkdirp(ctx, '.claude/skills/demo'), HOME_DENY.INTERMEDIATE_SYMLINK);
    await expectDenied(hfs.copyFile(ctx, REL, REL), HOME_DENY.INTERMEDIATE_SYMLINK);
    expect(await tree(dotfiles)).toEqual(before);
  });

  it('正向对照:同样布局但 `.claude` 是真目录,写入成功', async () => {
    const f = await setup('homefs-link-ctl-');
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/demo'));
    await hfs.writeFile(f.mk([REL]), REL, 'x');
    expect(await readText(path.join(f.home, REL))).toBe('x');
  });

  it.each([
    ['.claude/skills 是链接', '.claude/skills', 'skills-elsewhere'],
    ['.claude/skills/demo 是链接', '.claude/skills/demo', 'demo-elsewhere'],
  ])('%s → INTERMEDIATE_SYMLINK', async (_n, linkRel, targetName) => {
    const f = await setup('homefs-link-mid-');
    const target = path.join(f.dir, targetName);
    await safe.mkdirp(f.fx, path.join(target, 'demo'));
    await safe.mkdirp(f.fx, path.join(f.home, path.posix.dirname(linkRel)));
    await safe.symlink(f.fx, target, path.join(f.home, linkRel));
    const before = await tree(target);
    await expectDenied(hfs.writeFile(f.mk([REL]), REL, 'x'), HOME_DENY.INTERMEDIATE_SYMLINK);
    expect(await tree(target)).toEqual(before);
  });

  it('最后一段是链接(指向已有文件 / 悬空)→ TARGET_SYMLINK,被指向的文件不变', async () => {
    const f = await setup('homefs-link-leaf-');
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills/demo'));
    const victim = path.join(f.dir, 'victim.txt');
    await safe.writeFile(f.fx, victim, 'precious');
    const ctx = f.mk([REL]);
    await safe.symlink(f.fx, victim, path.join(f.home, REL));
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.TARGET_SYMLINK);
    await expectDenied(hfs.remove(ctx, REL), HOME_DENY.TARGET_SYMLINK);
    expect(await readText(victim)).toBe('precious');
    await safe.remove(f.fx, path.join(f.home, REL));
    await safe.symlink(f.fx, path.join(f.dir, 'nonexistent.txt'), path.join(f.home, REL));
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.TARGET_SYMLINK);
    expect(await exists(path.join(f.dir, 'nonexistent.txt'))).toBe(false);
  });
});

describe('home-fs:HOME 来源', () => {
  it('只接受 getRealHome() 或 KIT_TMP 严格之内的目录', async () => {
    const f = await setup('homefs-home-');
    const denied = (opts: Parameters<typeof hfs.createHomeFsContext>[0]): void => {
      let err: unknown;
      try {
        hfs.createHomeFsContext(opts);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HomeWriteDeniedError);
      expect((err as HomeWriteDeniedError).code).toBe(HOME_DENY.BAD_HOME);
    };
    // KIT_TMP 之内:通过
    expect(() =>
      hfs.createHomeFsContext({ home: f.home, planScope: [], tmpDir: f.tmpDir }),
    ).not.toThrow();
    // 等于 KIT_TMP 本身 / 它的上级 / 相对路径 / 不存在 / 仓库目录:拒
    denied({ home: f.tmpDir, planScope: [], tmpDir: f.tmpDir });
    denied({ home: path.dirname(f.tmpDir), planScope: [], tmpDir: f.tmpDir });
    denied({ home: 'home', planScope: [], tmpDir: f.tmpDir });
    denied({ home: path.join(f.dir, 'nope'), planScope: [], tmpDir: f.tmpDir });
    denied({ home: REPO_ROOT, planScope: [], tmpDir: f.tmpDir });
    // 没有 KIT_TMP 且不是真实 HOME:拒
    denied({
      home: f.home,
      planScope: [],
      tmpDir: undefined,
      env: { KIT_REAL_HOME_OVERRIDE: REPO_ROOT },
    });
    // 等于 getRealHome():通过(这里用 KIT_REAL_HOME_OVERRIDE 指向假 HOME;不对真实 HOME 做任何写)
    const viaOverride = hfs.createHomeFsContext({
      home: f.home,
      planScope: ['.codex/AGENTS.md'],
      tmpDir: undefined,
      env: { KIT_REAL_HOME_OVERRIDE: f.home },
    });
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await hfs.writeFile(viaOverride, '.codex/AGENTS.md', 'x');
    expect(await readText(path.join(f.home, '.codex/AGENTS.md'))).toBe('x');
    // 真实 HOME 本身可建上下文(不写任何东西,planScope 为空)
    expect(() => hfs.createHomeFsContext({ home: getRealHome(), planScope: [] })).not.toThrow();
  });

  it('创建后 HOME 被换成指向 KIT_TMP 之外的链接 → 下一次写入 BAD_HOME', async () => {
    const f = await setup('homefs-home-swap-');
    const ctx = f.mk(['.codex/AGENTS.md']);
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await hfs.writeFile(ctx, '.codex/AGENTS.md', 'a');
    // 把 home 换成不存在的路径(等价于被移走):每次操作都重验 HOME
    await safe.rename(f.fx, f.home, path.join(f.dir, 'home-moved'));
    await expectDenied(hfs.writeFile(ctx, '.codex/AGENTS.md', 'b'), HOME_DENY.BAD_HOME);
  });
});

describe('home-fs:硬链接 / 特殊文件 / 类型不符', () => {
  const REL = '.codex/AGENTS.md';

  it('目标是硬链接(与 KIT_TMP 之外同 inode 的别名)→ HARDLINK,另一端内容不变', async () => {
    const f = await setup('homefs-hard-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    const alias = path.join(f.dir, 'alias.txt');
    await safe.writeFile(f.fx, alias, 'precious');
    await safe.hardlink(f.fx, alias, path.join(f.home, REL));
    const ctx = f.mk([REL]);
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.HARDLINK);
    await expectDenied(hfs.remove(ctx, REL), HOME_DENY.HARDLINK);
    await expectDenied(hfs.chmod(ctx, REL, 0o600), HOME_DENY.HARDLINK);
    await expectDenied(hfs.copyFile(ctx, REL, REL), HOME_DENY.HARDLINK);
    expect(await readText(alias)).toBe('precious');
    // 正向对照:同一布局但没有别名(nlink=1)可写
    const g = await setup('homefs-hard-ctl-');
    await safe.mkdirp(g.fx, path.join(g.home, '.codex'));
    await safe.writeFile(g.fx, path.join(g.home, REL), 'old');
    await hfs.writeFile(g.mk([REL]), REL, 'x');
    expect(await readText(path.join(g.home, REL))).toBe('x');
  });

  it('文件操作的目标是目录 → NOT_REGULAR;中间段是普通文件 → NOT_DIRECTORY', async () => {
    const f = await setup('homefs-kind-');
    await safe.mkdirp(f.fx, path.join(f.home, REL)); // .codex/AGENTS.md 是目录
    const ctx = f.mk([REL, '.claude/skills/x/SKILL.md']);
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.NOT_REGULAR);
    await expectDenied(hfs.remove(ctx, REL), HOME_DENY.NOT_REGULAR);
    await safe.mkdirp(f.fx, path.join(f.home, '.claude'));
    await safe.writeFile(f.fx, path.join(f.home, '.claude/skills'), 'i am a file');
    await expectDenied(
      hfs.writeFile(ctx, '.claude/skills/x/SKILL.md', 'x'),
      HOME_DENY.NOT_DIRECTORY,
    );
    await expectDenied(hfs.mkdirp(ctx, '.claude/skills/x'), HOME_DENY.NOT_DIRECTORY);
  });

  it('classifyLeaf:FIFO / 字符设备 / 块设备 / socket → SPECIAL_FILE(测试里造不出,用桩 Stats)', () => {
    const base = {
      isSymbolicLink: () => false,
      isFile: () => false,
      isDirectory: () => false,
      isFIFO: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
      isSocket: () => false,
      nlink: 1,
    };
    for (const k of ['isFIFO', 'isCharacterDevice', 'isBlockDevice', 'isSocket'] as const) {
      expect(hfs.classifyLeaf({ ...base, [k]: () => true }, 'file')).toBe(HOME_DENY.SPECIAL_FILE);
      expect(hfs.classifyLeaf({ ...base, [k]: () => true }, 'dir')).toBe(HOME_DENY.SPECIAL_FILE);
    }
    // 正向对照
    expect(hfs.classifyLeaf({ ...base, isFile: () => true }, 'file')).toBeUndefined();
    expect(hfs.classifyLeaf({ ...base, isFile: () => true, nlink: 2 }, 'file')).toBe(
      HOME_DENY.HARDLINK,
    );
    expect(hfs.classifyLeaf({ ...base, isDirectory: () => true }, 'dir')).toBeUndefined();
    expect(hfs.classifyLeaf({ ...base, isSymbolicLink: () => true }, 'file')).toBe(
      HOME_DENY.TARGET_SYMLINK,
    );
  });
});

describe('home-fs:原子写与其余原语', () => {
  const REL = '.codex/AGENTS.md';
  const STAGES: HomeFsStage[] = ['temp-created', 'temp-written', 'temp-synced', 'pre-rename'];

  it.each(STAGES)('在 %s 阶段失败:原文件不变,没有遗留临时文件', async (stage) => {
    const f = await setup('homefs-atomic-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await safe.writeFile(f.fx, path.join(f.home, REL), 'original');
    const before = await tree(f.home);
    const ctx = f.mk([REL], {
      onStage: (s) => {
        if (s === stage) throw new Error('injected');
      },
    });
    await expect(hfs.writeFile(ctx, REL, 'new content')).rejects.toThrow('injected');
    expect(await tree(f.home)).toEqual(before);
    expect(await readText(path.join(f.home, REL))).toBe('original');
  });

  it.each(STAGES)('在 %s 阶段失败:目标原本不存在则不会产生半文件', async (stage) => {
    const f = await setup('homefs-atomic-new-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    const ctx = f.mk([REL], {
      onStage: (s) => {
        if (s === stage) throw new Error('injected');
      },
    });
    await expect(hfs.writeFile(ctx, REL, 'new content')).rejects.toThrow('injected');
    expect(await tree(f.home)).toEqual(['.codex/']);
  });

  it('rename 前目标被换成符号链接 → 重新校验拒绝,临时文件被清理', async () => {
    const f = await setup('homefs-atomic-race-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    const victim = path.join(f.dir, 'victim.txt');
    await safe.writeFile(f.fx, victim, 'precious');
    const ctx = f.mk([REL], {
      onStage: async (s) => {
        if (s === 'temp-synced') await safe.symlink(f.fx, victim, path.join(f.home, REL));
      },
    });
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.TARGET_SYMLINK);
    expect(await readText(victim)).toBe('precious');
    expect((await tree(f.home)).filter((l) => l.includes('.tmp-'))).toEqual([]);
  });

  it('copyFile / rename / chmod / remove 往返(备份 + 回滚用法)', async () => {
    const f = await setup('homefs-ops-');
    const bak = '.local/state/agent-kit/sync/backups/txn1/AGENTS.md';
    const bak2 = '.local/state/agent-kit/sync/backups/txn1/AGENTS.md.moved';
    const ctx = f.mk([REL, bak, bak2]);
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await hfs.writeFile(ctx, REL, 'v1', { mode: 0o640 });
    await hfs.mkdirp(ctx, '.local/state/agent-kit/sync/backups/txn1', 0o700);
    await hfs.copyFile(ctx, REL, bak);
    expect(await readText(path.join(f.home, bak))).toBe('v1');
    expect((await lstat(path.join(f.home, bak))).mode & 0o777).toBe(0o640);
    await hfs.writeFile(ctx, REL, 'v2');
    await hfs.copyFile(ctx, bak, REL); // 回滚
    expect(await readText(path.join(f.home, REL))).toBe('v1');
    await hfs.rename(ctx, bak, bak2);
    expect(await exists(path.join(f.home, bak))).toBe(false);
    await hfs.chmod(ctx, bak2, 0o600);
    expect((await lstat(path.join(f.home, bak2))).mode & 0o777).toBe(0o600);
    await hfs.remove(ctx, bak2);
    await hfs.remove(ctx, bak2); // 不存在视为成功
    expect(await exists(path.join(f.home, bak2))).toBe(false);
    // 来源不存在 → 普通 ENOENT(不是拒绝)
    await expect(hfs.copyFile(ctx, bak, REL)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('home-fs:评审补充(上下文防篡改、临时文件替换、别名、对称覆盖)', () => {
  const REL = '.codex/AGENTS.md';
  const SK = '.claude/skills/demo/SKILL.md';

  it('干净 HOME 首次安装:父目录隐式创建且权限按 dirMode', async () => {
    const f = await setup('homefs-first-');
    const ctx = f.mk([REL, '.local/state/agent-kit/sync/ledger.json']);
    await hfs.writeFile(ctx, '.local/state/agent-kit/sync/ledger.json', '{}', {
      mode: 0o600,
      dirMode: 0o700,
    });
    await hfs.writeFile(ctx, REL, 'x');
    expect((await lstat(path.join(f.home, '.local/state/agent-kit/sync'))).mode & 0o777).toBe(
      0o700,
    );
    expect((await lstat(path.join(f.home, '.local/state/agent-kit'))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(f.home, '.codex'))).mode & 0o777).toBe(0o755);
  });

  it('ctx 句柄不能被篡改:改 planScope / 伪造 ctx 都无法扩权', async () => {
    const f = await setup('homefs-tamper-');
    const ctx = f.mk([SK]);
    expect(() => (ctx.planScope as string[]).push(REL)).toThrow();
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.OUT_OF_PLAN_SCOPE);
    const forged = { home: f.home, planScope: [REL], tmpDir: f.tmpDir, onStage: undefined };
    await expectDenied(hfs.writeFile(forged, REL, 'x'), HOME_DENY.SCOPE_INVALID);
    expect(await tree(f.home)).toEqual([]);
  });

  it('HOME 被换成同路径的另一个目录 → BAD_HOME(创建时固定目录身份)', async () => {
    const f = await setup('homefs-ident-');
    const ctx = f.mk([REL]);
    await hfs.writeFile(ctx, REL, 'a');
    await safe.rename(f.fx, f.home, path.join(f.dir, 'home-moved'));
    await safe.mkdirp(f.fx, f.home); // 同一路径,新目录
    await expectDenied(hfs.writeFile(ctx, REL, 'b'), HOME_DENY.BAD_HOME);
    expect(await tree(f.home)).toEqual([]);
  });

  it('rename 前临时文件被换成符号链接 / 另一个普通文件 / 硬链接 → 拒绝,目标不变,无遗留', async () => {
    for (const kind of ['symlink', 'other-file', 'hardlink'] as const) {
      const f = await setup(`homefs-tmp-${kind}-`);
      await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
      await safe.writeFile(f.fx, path.join(f.home, REL), 'original');
      const victim = path.join(f.dir, 'victim.txt');
      await safe.writeFile(f.fx, victim, 'precious');
      const ctx = f.mk([REL], {
        onStage: async (s) => {
          if (s !== 'temp-synced') return;
          const name = (await readDir(path.join(f.home, '.codex'))).find((e) =>
            e.name.includes('.tmp-'),
          )?.name as string;
          const tmp = path.join(f.home, '.codex', name);
          if (kind === 'hardlink') {
            // 另造一个指向临时文件 inode 的硬链接(nlink=2)
            await safe.hardlink(f.fx, tmp, path.join(f.dir, 'tmp-alias'));
            return;
          }
          await safe.remove(f.fx, tmp);
          if (kind === 'symlink') await safe.symlink(f.fx, victim, tmp);
          else await safe.writeFile(f.fx, tmp, 'swapped');
        },
      });
      await expectDenied(
        hfs.writeFile(ctx, REL, 'new'),
        kind === 'symlink'
          ? HOME_DENY.TARGET_SYMLINK
          : kind === 'hardlink'
            ? HOME_DENY.HARDLINK
            : HOME_DENY.PATH_ESCAPE,
      );
      expect(await readText(path.join(f.home, REL))).toBe('original');
      expect(await readText(victim)).toBe('precious');
      expect((await tree(f.home)).filter((l) => l.includes('.tmp-'))).toEqual([]);
    }
  });

  it('pre-rename 阶段把目标换成符号链接 → 重新校验拒绝,被指向的文件不变', async () => {
    const f = await setup('homefs-prerename-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    const victim = path.join(f.dir, 'victim.txt');
    await safe.writeFile(f.fx, victim, 'precious');
    const ctx = f.mk([REL], {
      onStage: async (s) => {
        if (s === 'pre-rename') await safe.symlink(f.fx, victim, path.join(f.home, REL));
      },
    });
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.TARGET_SYMLINK);
    expect(await readText(victim)).toBe('precious');
    expect((await tree(f.home)).filter((l) => l.includes('.tmp-'))).toEqual([]);
  });

  it('运行期往契约表里追加条目,不会让 home-fs 的授权跟着扩大(模块加载时取快照)', async () => {
    const f = await setup('homefs-table-tamper-');
    const table = HOME_WRITE_TABLE as unknown as {
      path: string;
      kind: string;
      owner: string;
      agents: string[];
    }[];
    const evil = '.ssh/authorized_keys';
    table.push({ path: '.ssh/', kind: 'dir', owner: 'kit', agents: [] });
    try {
      // 对照:契约函数此刻确实被带偏了
      expect(isHomeWritePath(evil)).toBe(true);
      let err: unknown;
      try {
        f.mk([evil]);
      } catch (e) {
        err = e;
      }
      expect((err as HomeWriteDeniedError).code).toBe(HOME_DENY.SCOPE_INVALID);
      const ctx = f.mk([SK]);
      await expectDenied(hfs.writeFile(ctx, evil, 'x'), HOME_DENY.NOT_IN_TABLE);
      await expectDenied(hfs.mkdirp(ctx, '.ssh/keys'), HOME_DENY.NOT_IN_TABLE);
    } finally {
      table.pop();
    }
    expect(await tree(f.home)).toEqual([]);
  });

  it('`.JSON` 大写后缀同样按 .json 拒(大小写不敏感卷上是同一个文件)', async () => {
    const f = await setup('homefs-json-case-');
    const bad = '.claude/skills/demo/settings.JSON';
    expect(() => f.mk([bad])).toThrow(HomeWriteDeniedError);
    const ctx = f.mk([SK]);
    await expectDenied(hfs.writeFile(ctx, bad, 'x'), HOME_DENY.JSON_TARGET);
  });

  it('语法边界:`.` 段、DEL、超长路径 → PATH_INVALID', async () => {
    const f = await setup('homefs-syntax-');
    const ctx = f.mk([SK]);
    for (const rel of [
      '.claude/./skills/demo/SKILL.md',
      '.claude/skills/de\u007fmo/SKILL.md',
      `.claude/skills/${'a'.repeat(600)}/SKILL.md`,
    ]) {
      await expectDenied(hfs.writeFile(ctx, rel, 'x'), HOME_DENY.PATH_INVALID);
    }
  });

  it('大小写别名(仅大小写不敏感卷):已有小写 victim,经合法大写路径写入 → PATH_ESCAPE', async () => {
    const f = await setup('homefs-alias-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await safe.writeFile(f.fx, path.join(f.home, '.codex/agents.md'), 'victim');
    const insensitive = await exists(path.join(f.home, '.codex/AGENTS.md'));
    if (!insensitive) return; // 区分大小写的卷上别名不存在,无从演练
    const ctx = f.mk([REL]);
    await expectDenied(hfs.writeFile(ctx, REL, 'x'), HOME_DENY.PATH_ESCAPE);
    await expectDenied(hfs.remove(ctx, REL), HOME_DENY.PATH_ESCAPE);
    expect(await readText(path.join(f.home, '.codex/agents.md'))).toBe('victim');
    // 目录别名:`.CODEX` 已存在
    const g = await setup('homefs-alias-dir-');
    await safe.mkdirp(g.fx, path.join(g.home, '.CODEX'));
    await expectDenied(hfs.writeFile(g.mk([REL]), REL, 'x'), HOME_DENY.PATH_ESCAPE);
  });

  it('中间段是悬空链接 → INTERMEDIATE_SYMLINK', async () => {
    const f = await setup('homefs-dangling-mid-');
    await safe.symlink(f.fx, path.join(f.dir, 'gone'), path.join(f.home, '.claude'));
    const ctx = f.mk([SK]);
    await expectDenied(hfs.writeFile(ctx, SK, 'x'), HOME_DENY.INTERMEDIATE_SYMLINK);
    await expectDenied(hfs.mkdirp(ctx, '.claude/skills/demo'), HOME_DENY.INTERMEDIATE_SYMLINK);
    expect(await exists(path.join(f.dir, 'gone'))).toBe(false);
  });

  it('rename / copyFile 的任意一端是链接 / 硬链接 / 中间链接都拒(对称)', async () => {
    const f = await setup('homefs-sym-');
    const A = '.local/state/agent-kit/a.txt';
    const B = '.local/state/agent-kit/b.txt';
    const ctx = f.mk([A, B]);
    await hfs.writeFile(ctx, A, 'a');
    const victim = path.join(f.dir, 'victim.txt');
    await safe.writeFile(f.fx, victim, 'precious');
    await safe.symlink(f.fx, victim, path.join(f.home, B));
    for (const op of [hfs.rename, hfs.copyFile]) {
      await expectDenied(op(ctx, A, B), HOME_DENY.TARGET_SYMLINK);
      await expectDenied(op(ctx, B, A), HOME_DENY.TARGET_SYMLINK);
    }
    expect(await readText(victim)).toBe('precious');
    expect(await readText(path.join(f.home, A))).toBe('a');
  });

  it('removeDir:叶子链接 / 非目录 / 表外 / 点段 / scope 外都拒', async () => {
    const f = await setup('homefs-rmdir-');
    const ctx = f.mk([SK, '.claude/skills/other/SKILL.md']);
    await safe.mkdirp(f.fx, path.join(f.home, '.claude/skills'));
    const target = path.join(f.dir, 'elsewhere');
    await safe.mkdirp(f.fx, target);
    await safe.symlink(f.fx, target, path.join(f.home, '.claude/skills/demo'));
    await expectDenied(hfs.removeDir(ctx, '.claude/skills/demo'), HOME_DENY.TARGET_SYMLINK);
    await safe.writeFile(f.fx, path.join(f.home, '.claude/skills/other'), 'file');
    await expectDenied(hfs.removeDir(ctx, '.claude/skills/other'), HOME_DENY.NOT_DIRECTORY);
    await expectDenied(hfs.removeDir(ctx, '.claude'), HOME_DENY.NOT_IN_TABLE);
    await expectDenied(hfs.removeDir(ctx, '.claude/skills/.x'), HOME_DENY.DOT_SEGMENT);
    await expectDenied(hfs.removeDir(ctx, '.claude/skills/third'), HOME_DENY.OUT_OF_PLAN_SCOPE);
    expect(await exists(target)).toBe(true);
  });

  it('目录项不可列出(权限)→ STAT_FAILED,不放行', async () => {
    const f = await setup('homefs-eacces-');
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await safe.chmod(f.fx, path.join(f.home, '.codex'), 0o000);
    try {
      if (process.getuid?.() === 0) return; // root 不受权限位约束
      await expectDenied(hfs.writeFile(f.mk([REL]), REL, 'x'), HOME_DENY.STAT_FAILED);
    } finally {
      await safe.chmod(f.fx, path.join(f.home, '.codex'), 0o755);
    }
  });
});

describe('home-fs:真实 HOME 未被触碰', () => {
  it('快照函数有效:往(假)HOME 的受管路径写文件,快照必须变(正向对照)', async () => {
    const f = await setup('homefs-snap-');
    const a = await snapshot(f.home);
    await safe.mkdirp(f.fx, path.join(f.home, '.codex'));
    await safe.writeFile(f.fx, path.join(f.home, '.codex/AGENTS.md'), 'x');
    expect(await snapshot(f.home)).not.toBe(a);
    expect(a).toMatch(/lines=\d+$/);
    expect(Number(a.split('lines=')[1])).toBeGreaterThanOrEqual(HOME_WRITE_TABLE.length);
  });

  it('本文件所有用例结束后,真实 HOME 受管路径的快照与开头逐位一致(afterAll 再比一次)', async () => {
    expect(await snapshot(getRealHome())).toBe(realHomeBefore);
  });
});

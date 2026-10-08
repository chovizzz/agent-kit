import { describe, expect, it } from 'vitest';
import { createGuardGit, runGuards } from '../../src/guards/index.js';
import { ATOM_PATH, atom } from '../fixtures/guards/atoms.js';
import { PASS, scenario, useRepoCleanup } from './helpers.js';
import { makeTestRepo } from '../helpers/make-repo.js';

useRepoCleanup();

const base = (status = 'proposed') => ({ [ATOM_PATH]: atom({ status }) });

describe('绕过尝试:编码与行尾', () => {
  it('BOM + CRLF 的头部版本改 status:仍被 G2 抓到(与 lint 同一套归一化)', async () => {
    const s = await scenario(base(), {
      [ATOM_PATH]: atom({ status: 'active', bom: true, eol: '\r\n' }),
    });
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
  });

  it('旧 Mac 的 CR 行尾也被归一化,status 变化照样抓到', async () => {
    const s = await scenario(base(), { [ATOM_PATH]: atom({ status: 'active', eol: '\r' }) });
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
  });

  it('BOM + CRLF 的新增原子 status=active → G1', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ status: 'active', bom: true, eol: '\r\n' }) },
    );
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('正向控制:BOM + CRLF 的合规新增(proposed)→ 绿', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ bom: true, eol: '\r\n' }) },
    );
    expect(s.codes).toEqual([]);
  });

  it('G3:只有行尾/BOM 变化 + status 合法转移 → 视为单纯的转移(无其它字段变化)', async () => {
    const s = await scenario(
      base('proposed'),
      { [ATOM_PATH]: atom({ status: 'advisory', bom: true, eol: '\r\n' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual([]);
  });
});

describe('绕过尝试:YAML 技巧(受限解析,与 lint 一致)', () => {
  it('重复 status 键(后者生效的解析器会被骗)→ GUARD_FRONTMATTER_UNPARSEABLE', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['status: active'] }) },
    );
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('修改已有原子时引入重复 status 键 → UNPARSEABLE', async () => {
    const s = await scenario(base('proposed'), {
      [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['status: active'] }),
    });
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('YAML 别名 / 锚点 / 显式 tag → UNPARSEABLE', async () => {
    for (const extra of [['tmp: &a active', 'copy: *a'], ['tmp: &a active'], ['tmp: !!str x']]) {
      const s = await scenario(
        { 'README.md': 'x\n' },
        { [ATOM_PATH]: atom({ extraLines: extra }) },
      );
      expect(s.codes, extra.join('|')).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
    }
  });

  it('多文档(`...` 之后再来一份)→ UNPARSEABLE', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ extraLines: ['...', 'status: active'] }) },
    );
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('缺 frontmatter / 围栏带尾随空格 / 顶层不是映射 → UNPARSEABLE', async () => {
    for (const text of [
      '**做**:x\n',
      atom().replace('---\nid', '--- \nid'),
      '---\n- a\n- b\n---\nbody\n',
      '---\n---\nbody\n',
    ]) {
      const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: text });
      expect(s.codes, text.slice(0, 20)).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
    }
  });

  it('基线版本坏了、头部是好的:也 fail-closed(无法比较)', async () => {
    const s = await scenario(
      { [ATOM_PATH]: '没有 frontmatter\n' },
      { [ATOM_PATH]: atom({ status: 'proposed' }) },
    );
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('键名变体:Status(大写)不算 status → 新增原子视为缺 status → G1', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ omitStatus: true, extraLines: ['Status: proposed'] }) },
    );
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('带引号的键 "status" 与普通键等价:合规与违规各一例', async () => {
    const ok = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ omitStatus: true, extraLines: ['"status": proposed'] }) },
    );
    expect(ok.codes).toEqual([]);
    const bad = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ omitStatus: true, extraLines: ["'status': active"] }) },
    );
    expect(bad.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('status 为 null(`status:` 空值)→ G1 红', async () => {
    const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: atom({ status: '' }) });
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('注释里的 "status: active" 不是字段:G2 绿(已知边界:守卫只比较解析后的字段与正文,不比较注释)', async () => {
    const s = await scenario(base('proposed'), {
      [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['# status: active'] }),
    });
    expect(s.codes).toEqual([]);
  });
});

describe('绕过尝试:文件类型与路径', () => {
  it('把原子文件换成符号链接(类型变更)→ UNPARSEABLE', async () => {
    const s = await scenario(base(), { [ATOM_PATH]: { link: 'elsewhere.md' } });
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('新增的原子路径是符号链接 → UNPARSEABLE', async () => {
    const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: { link: 'elsewhere.md' } });
    expect(s.codes).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
  });

  it('把 active 原子移到别的目录并把 status 改回 proposed → 旧路径删除被 G4 拦(改名洗状态不成)', async () => {
    const s = await scenario(base('active'), {
      [ATOM_PATH]: null,
      'rules/other-dir/moved.md': atom({ status: 'proposed' }),
    });
    expect(s.codes).toEqual(['GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('原子路径上的 gitlink(子模块,mode 160000)→ UNPARSEABLE,而不是去读 blob 崩溃', async () => {
    const repo = await makeTestRepo();
    await repo.commit({ 'README.md': 'x\n' }, 'base');
    repo.tag('kit-base');
    const oid = repo.git(['rev-parse', 'HEAD']).trim();
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${oid},${ATOM_PATH}`]);
    repo.git(['commit', '--quiet', '-m', 'gitlink']);
    repo.tag('kit-head');
    const r = runGuards({
      git: createGuardGit(repo.io, repo.dir, repo.gitEnv),
      base: 'kit-base',
      head: 'kit-head',
      label: undefined,
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['GUARD_FRONTMATTER_UNPARSEABLE']);
    expect(r.diagnostics[0]?.message).toContain('不是普通文件');
    await repo.dispose();
  });

  it('正向控制:只改 mode(chmod +x)、内容未变 → 绿', async () => {
    const s = await scenario(base(), {
      [ATOM_PATH]: { content: atom({ status: 'proposed' }), exec: true },
    });
    expect(s.codes).toEqual([]);
  });

  it('正向控制:没有任何改动(base == head)→ 绿,changed=0', async () => {
    const s = await scenario(base(), {});
    expect(s.codes).toEqual([]);
    expect(s.result.changed).toBe(0);
  });
});

describe('ref 处理', () => {
  it('分支名 / 注解 tag / 完整 oid / 缩写 oid 都能作为 --base --head', async () => {
    const repo = await makeTestRepo();
    const c1 = await repo.commit({ 'README.md': 'x\n' }, 'c1');
    repo.tag('v-annotated', 'HEAD', true);
    repo.branch('feature');
    const c2 = await repo.commit({ [ATOM_PATH]: atom({ status: 'proposed' }) }, 'c2');
    const git = createGuardGit(repo.io, repo.dir, repo.gitEnv);
    for (const [b, h] of [
      ['v-annotated', 'feature'],
      [c1, c2],
      [c1.slice(0, 10), c2.slice(0, 10)],
    ] as const) {
      const r = runGuards({ git, base: b, head: h, label: undefined });
      expect(r.changed, `${b}..${h}`).toBe(1);
      expect(r.diagnostics).toEqual([]);
    }
    await repo.dispose();
  });

  it('不存在的 ref、以 - 开头的 ref(选项注入)、空串 → RefError', async () => {
    const repo = await makeTestRepo();
    await repo.commit({ 'README.md': 'x\n' }, 'c1');
    const git = createGuardGit(repo.io, repo.dir, repo.gitEnv);
    for (const bad of ['nope', '--help', '-x', '', 'HEAD~99']) {
      expect(() => runGuards({ git, base: bad, head: 'HEAD', label: undefined }), bad).toThrow(
        /无法把 --base/,
      );
      expect(() => runGuards({ git, base: 'HEAD', head: bad, label: undefined }), bad).toThrow(
        /无法把 --head/,
      );
    }
    await repo.dispose();
  });
});

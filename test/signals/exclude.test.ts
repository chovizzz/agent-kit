import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdirp, symlink } from '../../src/io/safe-fs.js';
import {
  createExcludePolicy,
  ExcludeConfigError,
  hasProtection,
} from '../../src/signals/exclude.js';
import { newWork } from './helpers.js';

describe('排除策略(决策 ③A)', () => {
  it('无任何保护 → 拒绝构造(默认拒绝的内核)', async () => {
    expect(hasProtection({ excludeDirs: [], allowProjects: [] })).toBe(false);
    await expect(
      createExcludePolicy({ excludeDirs: [], allowProjects: [] }),
    ).rejects.toBeInstanceOf(ExcludeConfigError);
  });

  it('exclude_dirs:目录本身与子目录被排除;同名前缀的兄弟目录不被排除(路径段边界)', async () => {
    const p = await createExcludePolicy({ excludeDirs: ['/clients/acme'], allowProjects: [] });
    expect((await p.decide('/clients/acme')).action).toBe('skip');
    expect((await p.decide('/clients/acme/app/sub')).action).toBe('skip');
    expect((await p.decide('/clients/acme/')).action).toBe('skip'); // 尾斜杠
    expect((await p.decide('/clients/ACME/app')).action).toBe('skip'); // 大小写不敏感(更保守)
    expect((await p.decide('/clients/acme-evil/app')).action).toBe('process'); // 正向对照
    expect((await p.decide('/mine/social-ops-hub')).action).toBe('process');
  });

  it('排除目录用符号链接前缀写法配置、会话 cwd 是已删除目录的真实路径写法 → 仍被排除(解析最长已存在前缀;对照:别的项目不受影响)', async () => {
    const w = await newWork('excl-deleted-');
    const real = path.join(w.dir, 'real');
    await mkdirp(w.io, real);
    const alias = path.join(w.dir, 'alias');
    await symlink(w.io, real, alias);
    // client-x 目录从未存在(等价于「项目目录已被删除」):realpath 对整条路径会失败。
    const p = await createExcludePolicy({
      excludeDirs: [path.join(alias, 'client-x')],
      allowProjects: [],
    });
    expect((await p.decide(path.join(real, 'client-x', 'app'))).action).toBe('skip');
    expect((await p.decide(path.join(alias, 'client-x', 'app'))).action).toBe('skip');
    // 正向对照:同一个符号链接前缀下的其它项目不被误排除
    expect((await p.decide(path.join(real, 'other', 'app'))).action).toBe('process');
    expect((await p.decide(path.join(alias, 'other', 'app'))).action).toBe('process');
  });

  it('cwd_hint 为 null:无法证明不在排除目录里 → 跳过并标 unknown_project', async () => {
    const p = await createExcludePolicy({ excludeDirs: ['/clients/acme'], allowProjects: [] });
    expect(await p.decide(null)).toEqual({ action: 'skip', reason: 'unknown_project' });
  });

  it('相对路径的 cwd_hint 不按 collector 的 cwd 解释:当作未知项目跳过(正向对照:绝对路径正常处理)', async () => {
    const p = await createExcludePolicy({ excludeDirs: [], allowProjects: ['/work/skills-hub'] });
    expect(await p.decide('skills-hub/pkg')).toEqual({ action: 'skip', reason: 'unknown_project' });
    expect((await p.decide('/work/skills-hub/pkg')).action).toBe('process');
  });

  it('符号链接:排除目录的链接别名同样被排除(realpath 后比较)', async () => {
    const w = await newWork('ex-link-');
    const real = path.join(w.dir, 'real-client');
    await mkdirp(w.io, real);
    const alias = path.join(w.dir, 'alias-client');
    await symlink(w.io, real, alias);
    const p = await createExcludePolicy({ excludeDirs: [real], allowProjects: [] });
    expect((await p.decide(alias)).action).toBe('skip');
    expect((await p.decide(path.join(w.dir, 'other'))).action).toBe('process');
  });

  it('allow-project:名字 = basename 精确相等;绝对路径 = 段边界前缀;其余跳过', async () => {
    const p = await createExcludePolicy({
      excludeDirs: [],
      allowProjects: ['social-ops-hub', '/work/skills-hub'],
    });
    expect((await p.decide('/a/b/social-ops-hub')).action).toBe('process');
    expect((await p.decide('/a/b/social-ops-hub-evil')).action).toBe('skip');
    expect((await p.decide('/clients/acme/social-ops-hub/sub')).action).toBe('skip'); // 名字不做任意段匹配
    const sub = await p.decide('/work/skills-hub/pkg/x');
    expect(sub).toEqual({ action: 'process', projectRoot: '/work/skills-hub' }); // 子目录并入项目根
    expect((await p.decide('/work/skills-hub-x')).action).toBe('skip');
    expect(await p.decide('/clients/acme/app')).toEqual({ action: 'skip', reason: 'not_allowed' });
  });

  it('exclude 优先于 allow', async () => {
    const p = await createExcludePolicy({
      excludeDirs: ['/a/social-ops-hub'],
      allowProjects: ['social-ops-hub'],
    });
    expect((await p.decide('/a/social-ops-hub')).action).toBe('skip');
    expect((await p.decide('/b/social-ops-hub')).action).toBe('process');
  });

  it('非法配置:相对的 exclude_dirs、带分隔符的相对 allow 名字、空串', async () => {
    await expect(
      createExcludePolicy({ excludeDirs: ['rel/dir'], allowProjects: [] }),
    ).rejects.toThrow(ExcludeConfigError);
    await expect(createExcludePolicy({ excludeDirs: [], allowProjects: ['a/b'] })).rejects.toThrow(
      ExcludeConfigError,
    );
    await expect(createExcludePolicy({ excludeDirs: [], allowProjects: [''] })).rejects.toThrow(
      ExcludeConfigError,
    );
  });
});

/**
 * R20-A2 B3c:暂存区即时闸(R20-4.8)与 judge 的三个回调。对着真实配置 / 索引 / 信号库 / 暂存区;闸本身零写入(写审计钩子计数)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { immediateGate, judgeGateCallbacks } from '../../src/rsi/services/immediate-gate.js';
import {
  KEY_A,
  KEY_B,
  KEY_C,
  addSignals,
  countsDoc,
  makeRoot,
  makeSvc,
  projPath,
  put,
  runDirOf,
  setRsiToml,
  stageRun,
  writeCountsRaw,
  writeIndex,
  type Svc,
} from './services-fixture.js';

const SIG_A = '1111111111111111';
const SIG_B = '2222222222222222';
const SIG_C = '3333333333333333';
const SIG_NOWHERE = '9999999999999999';

interface World {
  s: Svc;
  rootA: string;
  rootB: string;
  rootC: string;
}

/** A 被排除(配置里),B / C 是采集中;信号 sig→key;索引与 counts 一致 */
async function world(prefix: string, excludeA = true): Promise<World> {
  const s = await makeSvc(prefix, {
    extraToml: (f) =>
      excludeA ? `exclude_dirs = [${JSON.stringify(projPath(f, 'projA'))}]\n` : '',
  });
  const rootA = await makeRoot(s, 'projA');
  const rootB = await makeRoot(s, 'projB');
  const rootC = await makeRoot(s, 'projC');
  await addSignals(s, [
    { id: SIG_A, key: KEY_A },
    { id: SIG_B, key: KEY_B },
    { id: SIG_C, key: KEY_C },
  ]);
  await writeIndex(s, [
    { key: KEY_A, root: rootA },
    { key: KEY_B, root: rootB },
    { key: KEY_C, root: rootC },
  ]);
  await writeCountsRaw(s, countsDoc());
  return { s, rootA, rootB, rootC };
}

const scopes = [
  { kind: 'judge', runId: 'run-1' },
  { kind: 'promote', runId: 'run-1' },
] as const;

const ALLOW = { kind: 'allow' };

describe('immediateGate:配置(privacyGate;cfg_* 不是 legacy)', () => {
  const cases: { name: string; write: (w: World) => Promise<void>; want: 'allow' | string }[] = [
    {
      name: 'absent(配置文件不存在)',
      write: async (w) => remove(w.s.f.fx, w.s.f.cfgFile),
      want: 'allow',
    },
    {
      name: 'no_section(没有 [rsi])',
      write: async (w) => writeFile(w.s.f.fx, w.s.f.cfgFile, '[other]\nx = 1\n', { mode: 0o600 }),
      want: 'allow',
    },
    {
      name: 'disabled',
      write: async (w) =>
        writeFile(w.s.f.fx, w.s.f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 }),
      want: 'allow',
    },
    {
      name: 'cfg_perm',
      write: async (w) => chmod(w.s.f.fx, w.s.f.cfgFile, 0o666),
      want: 'cfg_perm',
    },
    {
      name: 'cfg_parse',
      write: async (w) => writeFile(w.s.f.fx, w.s.f.cfgFile, '[rsi\nbroken', { mode: 0o600 }),
      want: 'cfg_parse',
    },
    {
      name: 'cfg_schema',
      write: async (w) =>
        writeFile(w.s.f.fx, w.s.f.cfgFile, '[rsi]\nenabled = true\nunknown_key = 1\n', {
          mode: 0o600,
        }),
      want: 'cfg_schema',
    },
    {
      name: 'repo_invalid',
      write: async (w) =>
        writeFile(
          w.s.f.fx,
          w.s.f.cfgFile,
          `[rsi]\nenabled = true\nrepo = ${JSON.stringify(path.join(w.s.f.dir, 'nope'))}\n`,
          { mode: 0o600 },
        ),
      want: 'repo_invalid',
    },
    {
      name: 'overlay_invalid',
      write: async (w) =>
        writeFile(
          w.s.f.fx,
          w.s.f.cfgFile,
          `[rsi]\nenabled = true\nrepo = ${JSON.stringify(w.s.f.repo)}\noverlay = ${JSON.stringify(path.join(w.s.f.dir, 'nope.toml'))}\n`,
          { mode: 0o600 },
        ),
      want: 'overlay_invalid',
    },
    {
      name: 'exclude_invalid',
      write: async (w) => setRsiToml(w.s, 'exclude_dirs = ["relative"]\n'),
      want: 'exclude_invalid',
    },
  ];
  for (const scope of scopes) {
    for (const c of cases) {
      it(`${scope.kind} × ${c.name} → ${c.want === 'allow' ? 'allow(旧流程,不读任何东西)' : `fail_closed ${c.want}`}`, async () => {
        const w = await world(`gate-cfg-${scope.kind}-`);
        // run 带 TAINTED:legacy 时仍 allow(没有 [rsi] 不做闸),其余配置问题在读标记之前就挡下
        await stageRun(w.s, 'run-1', [SIG_A]);
        await put(
          w.s,
          path.join(runDirOf(w.s, 'run-1'), 'TAINTED'),
          canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
        );
        await c.write(w);
        const before = w.s.audit.length;
        const r = await immediateGate(w.s.ctx, scope);
        if (c.want === 'allow') expect(r).toEqual(ALLOW);
        else
          expect(r).toEqual({
            kind: 'fail_closed',
            code: 'RSI_FAIL_CLOSED',
            reason: c.want,
            exit: 3,
          });
        expect(w.s.audit.length, '闸零写入').toBe(before);
      });
    }
  }
  it('enforce(on、无 block)才走后面的判定(对照:同一 run 此时是 tainted)', async () => {
    const w = await world('gate-cfg-enforce-');
    await stageRun(w.s, 'run-1', [SIG_A]);
    await put(
      w.s,
      path.join(runDirOf(w.s, 'run-1'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({ kind: 'tainted' });
  });
});

describe('immediateGate:标记 / journal / 归属', () => {
  it('TAINTED:reason 取标记里的值;空文件 / 半个 JSON / 目录也算已标记(reason 按 exclude)', async () => {
    for (const [i, body] of [
      canonicalJson({ reason: 'purge', at: '2026-10-26T00:00:00.000Z' }),
      '',
      '{"rea',
      null,
    ].entries()) {
      const w = await world(`gate-mark-${i}-`);
      await stageRun(w.s, 'run-1', [SIG_B]);
      const mark = path.join(runDirOf(w.s, 'run-1'), 'TAINTED');
      if (body === null) await mkdirp(w.s.f.fx, mark, 0o700);
      else await put(w.s, mark, body);
      expect(await immediateGate(w.s.ctx, scopes[0])).toEqual({
        kind: 'tainted',
        code: 'RSI_RUN_TAINTED',
        runId: 'run-1',
        reason: i === 0 ? 'purge' : 'exclude',
        exit: 1,
      });
    }
  });

  it('P:证据全属于采集中项目 → allow(对照);run 不存在 / 无证据 → allow;runId 不合法 → fail_closed internal', async () => {
    const w = await world('gate-p-');
    await stageRun(w.s, 'run-1', [SIG_B, SIG_C]);
    expect(await immediateGate(w.s.ctx, scopes[0])).toEqual(ALLOW);
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'no-such-run' })).toEqual(ALLOW);
    for (const bad of ['../etc', 'a/b', '', 'cwd', '.hidden']) {
      expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: bad })).toMatchObject({
        kind: 'fail_closed',
        reason: 'internal',
      });
    }
  });

  it('X:证据属于被排除项目 → tainted(exclude),不必等 taint 落盘;混合优先级 X > U、P+X → tainted', async () => {
    const w = await world('gate-x-');
    await stageRun(w.s, 'run-1', [SIG_A]);
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'tainted',
      reason: 'exclude',
      exit: 1,
    });
    await stageRun(w.s, 'run-pa', [SIG_B, SIG_A]);
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'run-pa' })).toMatchObject({
      kind: 'tainted',
    });
    // X + U(一条证据映射不到):X 不被 U 覆盖
    await stageRun(w.s, 'run-xu', [SIG_A, SIG_NOWHERE]);
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'run-xu' })).toMatchObject({
      kind: 'tainted',
    });
    // P + U → attribution_unknown
    await stageRun(w.s, 'run-pu', [SIG_B, SIG_NOWHERE]);
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'run-pu' })).toEqual({
      kind: 'attribution_unknown',
      code: 'RSI_RUN_ATTRIBUTION_UNKNOWN',
      runId: 'run-pu',
      exit: 1,
    });
  });

  it('U 的各条来路:索引缺失 / 损坏 / 盐不符(index 对 counts)/ counts 缺失 / key 不在索引 / sig 映射不到 / 根路径被换 inode / 根路径不存在 / 暂存文件无法解析', async () => {
    const wantU = async (w: World, why: string): Promise<void> => {
      expect(await immediateGate(w.s.ctx, scopes[0]), why).toEqual({
        kind: 'attribution_unknown',
        code: 'RSI_RUN_ATTRIBUTION_UNKNOWN',
        runId: 'run-1',
        exit: 1,
      });
    };
    {
      const w = await world('gate-u1-');
      await stageRun(w.s, 'run-1', [SIG_B]);
      expect(await immediateGate(w.s.ctx, scopes[0]), '对照:一切就绪时是 P').toEqual(ALLOW);
      await remove(w.s.f.fx, path.join(w.s.rsi, 'projects.json'));
      await wantU(w, '索引缺失');
      await put(w.s, path.join(w.s.rsi, 'projects.json'), '{broken');
      await wantU(w, '索引损坏');
    }
    {
      const w = await world('gate-u2-');
      await stageRun(w.s, 'run-1', [SIG_B]);
      await writeCountsRaw(w.s, countsDoc('0'.repeat(12)));
      await wantU(w, '盐不符');
      await remove(w.s.f.fx, path.join(w.s.rsi, 'counts.json'));
      await wantU(w, 'counts 缺失');
    }
    {
      const w = await world('gate-u3-');
      await addSignals(w.s, [{ id: SIG_NOWHERE, key: 'p_dddddddddddddddd' }], '202609');
      await stageRun(w.s, 'run-1', [SIG_NOWHERE]);
      await wantU(w, 'key 不在索引里');
    }
    {
      const w = await world('gate-u4-');
      await stageRun(w.s, 'run-1', ['8888888888888888']);
      await wantU(w, 'sig 在信号库里映射不到');
    }
    {
      const w = await world('gate-u5-');
      await stageRun(w.s, 'run-1', [SIG_B]);
      // 删后重建:同路径、新 inode
      await remove(w.s.f.fx, w.rootB);
      await mkdirp(w.s.f.fx, w.rootB, 0o755);
      await wantU(w, '根路径 (dev, ino) 变了');
      await remove(w.s.f.fx, w.rootB);
      await wantU(w, '根路径不存在');
    }
    {
      const w = await world('gate-u6-');
      await stageRun(w.s, 'run-1', [SIG_B]);
      await put(
        w.s,
        path.join(runDirOf(w.s, 'run-1'), 'proposals', '2026-10-26-001.yaml'),
        '{{{ broken',
      );
      await wantU(w, '暂存提案无法解析');
    }
    {
      const w = await world('gate-u7-');
      await stageRun(w.s, 'run-1', [SIG_B], {
        extraFiles: { 'proposals/x.yaml.abcd.tmp': 'stray' },
      });
      await wantU(w, '暂存区有 .tmp 残留');
    }
  });

  it('原子证据形状异常(缺 type / 缺 ref / 空串)→ attribution_unknown,不当「没有证据」;合法的非 trace 类型不触发;混合时 X 仍优先', async () => {
    const mdWith = async (w: World, id: string, evidence: string): Promise<void> => {
      await put(
        w.s,
        path.join(runDirOf(w.s, id), 'rules', 'team', 'a.md'),
        `---\nid: a\ntitle: T\nlayer: team\nstrength: should\nkind: preference\nvolatility: stable\nstatus: proposed\nowner: o\ncreated: 2026-10-26\nreview_by: 2027-01-26\nevidence:\n${evidence}verifier:\n  type: none\n---\n\n**做**:x\n**为什么**:y\n**怎么验**:z\n`,
      );
      await remove(w.s.f.fx, path.join(runDirOf(w.s, id), 'proposals'));
    };
    const w = await world('gate-atom-shape-');
    for (const [i, ev] of [
      '  - excerpt: "x"\n',
      '  - type: trace\n    excerpt: "x"\n',
      '  - type: ""\n    ref: r\n    excerpt: x\n',
    ].entries()) {
      await stageRun(w.s, `run-bad${i}`, [SIG_B]);
      await mdWith(w, `run-bad${i}`, ev);
      expect(
        await immediateGate(w.s.ctx, { kind: 'judge', runId: `run-bad${i}` }),
        ev,
      ).toMatchObject({
        kind: 'attribution_unknown',
      });
    }
    await stageRun(w.s, 'run-memory', [SIG_B]);
    await mdWith(w, 'run-memory', '  - type: memory\n    ref: note-1\n    excerpt: x\n');
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'run-memory' })).toEqual(ALLOW);
    await stageRun(w.s, 'run-mixed', [SIG_A]);
    await mdWith(
      w,
      'run-mixed',
      `  - excerpt: x\n  - type: trace\n    ref: sig_${SIG_A}\n    excerpt: x\n`,
    );
    expect(await immediateGate(w.s.ctx, { kind: 'judge', runId: 'run-mixed' })).toMatchObject({
      kind: 'tainted',
    });
  });

  it('根路径经大小写 / 别名写法变化:最近一次根路径的 realpath 与记录不逐字节相等 → U', async () => {
    const w = await world('gate-case-');
    await stageRun(w.s, 'run-1', [SIG_B]);
    // 把记录里的路径改成同一目录的另一种写法(多一层 ./)
    await writeIndex(w.s, [
      { key: KEY_A, root: w.rootA },
      { key: KEY_B, root: w.rootB },
      { key: KEY_C, root: w.rootC },
    ]);
    const raw = JSON.parse(await readText(path.join(w.s.rsi, 'projects.json')));
    for (const e of raw.entries) if (e.key === KEY_B) e.roots[0].path = `${w.rootB}/.`;
    await put(w.s, path.join(w.s.rsi, 'projects.json'), canonicalJson(raw));
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({ kind: 'attribution_unknown' });
  });

  it('purge journal:present / unreadable → purge_incomplete,invalid → journal_invalid;journal 先于归属(同一 run 证据是 U 时仍报 journal)', async () => {
    const w = await world('gate-journal-');
    await stageRun(w.s, 'run-1', [SIG_NOWHERE]);
    const file = path.join(w.s.rsi, 'purge-journal.json');
    const ok = {
      schema_version: 1,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'tainted',
      keys: [KEY_A],
      taint_targets: { runs: [], promotes: [] },
    };
    await put(w.s, file, canonicalJson(ok));
    expect(await immediateGate(w.s.ctx, scopes[0])).toEqual({
      kind: 'fail_closed',
      code: 'RSI_FAIL_CLOSED',
      reason: 'purge_incomplete',
      exit: 3,
    });
    await put(w.s, file, 'garbage');
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'journal_invalid',
    });
    await put(w.s, file, canonicalJson(ok));
    await chmod(w.s.f.fx, file, 0o644);
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'purge_incomplete',
    });
    await remove(w.s.f.fx, file);
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({ kind: 'attribution_unknown' }); // 对照:journal 没了才轮到归属
  });

  it('信号库损坏(坏行 / 同 sig 两个 key)→ fail_closed signal_store_corrupt', async () => {
    const w = await world('gate-corrupt-');
    await stageRun(w.s, 'run-1', [SIG_B]);
    await put(w.s, path.join(w.s.state, 'signals', 'claude', '202609.jsonl'), 'not json\n');
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'signal_store_corrupt',
    });
    await put(w.s, path.join(w.s.state, 'signals', 'claude', '202609.jsonl'), '');
    await addSignals(w.s, [{ id: SIG_B, key: KEY_C }], '202609');
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'signal_store_corrupt',
    });
  });

  it('rsi 目录元数据不合规(权限宽于 0700)→ fail_closed:journal 探测读不出,不能证明「没有 journal」,按 purge_incomplete', async () => {
    const w = await world('gate-unsafe-');
    await stageRun(w.s, 'run-1', [SIG_B]);
    await chmod(w.s.f.fx, w.s.rsi, 0o755);
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'purge_incomplete',
    });
  });

  it('projects.json 元数据不合规(权限宽于 0600)→ fail_closed state_dir_unsafe,不当 U', async () => {
    const w = await world('gate-unsafe-idx-');
    await stageRun(w.s, 'run-1', [SIG_B]);
    await chmod(w.s.f.fx, path.join(w.s.rsi, 'projects.json'), 0o644);
    expect(await immediateGate(w.s.ctx, scopes[0])).toMatchObject({
      kind: 'fail_closed',
      reason: 'state_dir_unsafe',
    });
  });
});

describe('路径祖先是符号链接:逐级不跟随,fail-closed,不会读到链接目标里的「合法证据」', () => {
  it('reflect/(暂存根)与 reflect/<run>/(run 目录)被换成链接 → fail_closed state_dir_unsafe,绝不 allow', async () => {
    for (const which of ['root', 'run'] as const) {
      const w = await world(`gate-link-${which}-`);
      await stageRun(w.s, 'run-1', [SIG_B]);
      expect(await immediateGate(w.s.ctx, scopes[0]), '对照:链接之前是 allow').toEqual(ALLOW);
      const target = which === 'root' ? path.join(w.s.state, 'reflect') : runDirOf(w.s, 'run-1');
      const real = `${target}-real`;
      await rename(w.s.f.fx, target, real);
      await symlink(w.s.f.fx, real, target);
      expect(await immediateGate(w.s.ctx, scopes[0]), which).toMatchObject({
        kind: 'fail_closed',
        reason: 'state_dir_unsafe',
      });
    }
  });
});

describe('judgeGateCallbacks:三个回调各自现算,不缓存', () => {
  const names = ['beforeExternalCall', 'beforePersist', 'beforeOutput'] as const;

  it('同一组回调:allow → 收紧排除 → tainted(每个回调单独验证,ctx.config 快照不影响)', async () => {
    for (const name of names) {
      const w = await world(`gate-cb-x-${name}-`, false);
      await stageRun(w.s, 'run-1', [SIG_A]);
      const cbs = judgeGateCallbacks(w.s.ctx, { kind: 'judge', runId: 'run-1' });
      expect(await cbs[name](), `${name} 起初 allow`).toEqual(ALLOW);
      await setRsiToml(w.s, `exclude_dirs = [${JSON.stringify(w.rootA)}]\n`);
      expect(await cbs[name](), `${name} 收紧后`).toMatchObject({
        kind: 'tainted',
        reason: 'exclude',
      });
      await setRsiToml(w.s, '');
      expect(await cbs[name](), `${name} 放宽后恢复 allow(没有缓存拒绝)`).toEqual(ALLOW);
    }
  });

  it('allow → 下一次前出现 journal → fail_closed;journal 消失 → allow', async () => {
    for (const name of names) {
      const w = await world(`gate-cb-j-${name}-`);
      await stageRun(w.s, 'run-1', [SIG_B]);
      const cbs = judgeGateCallbacks(w.s.ctx, { kind: 'judge', runId: 'run-1' });
      expect(await cbs[name]()).toEqual(ALLOW);
      const file = path.join(w.s.rsi, 'purge-journal.json');
      await put(
        w.s,
        file,
        canonicalJson({
          schema_version: 1,
          created_at: '2026-10-26T00:00:00.000Z',
          phase: 'planned',
          keys: [KEY_B],
          taint_targets: { runs: [], promotes: [] },
        }),
      );
      expect(await cbs[name](), name).toMatchObject({
        kind: 'fail_closed',
        reason: 'purge_incomplete',
      });
      await remove(w.s.f.fx, file);
      expect(await cbs[name]()).toEqual(ALLOW);
    }
  });

  it('异常分支:第一次 allow 后索引被删(归属变 U)→ beforeOutput 报 attribution_unknown;配置被改坏 → fail_closed', async () => {
    const w = await world('gate-cb-u-');
    await stageRun(w.s, 'run-1', [SIG_B]);
    const cbs = judgeGateCallbacks(w.s.ctx, { kind: 'judge', runId: 'run-1' });
    expect(await cbs.beforeExternalCall()).toEqual(ALLOW);
    expect(await cbs.beforePersist()).toEqual(ALLOW);
    await remove(w.s.f.fx, path.join(w.s.rsi, 'projects.json'));
    expect(await cbs.beforeOutput()).toMatchObject({ kind: 'attribution_unknown' });
    await writeFile(w.s.f.fx, w.s.f.cfgFile, '[rsi\nbroken', { mode: 0o600 });
    expect(await cbs.beforeOutput()).toMatchObject({ kind: 'fail_closed', reason: 'cfg_parse' });
  });

  it('三个回调是三个独立闭包', async () => {
    const w = await world('gate-cb-id-');
    const cbs = judgeGateCallbacks(w.s.ctx, { kind: 'promote', runId: 'run-1' });
    expect(new Set([cbs.beforeExternalCall, cbs.beforePersist, cbs.beforeOutput]).size).toBe(3);
  });
});

describe('闸本身零写入 / 不建目录', () => {
  it('没有 rsi/ 目录时调用:不创建 rsi/、写审计零调用', async () => {
    const s = await makeSvc('gate-nodir-');
    await stageRun(s, 'run-1', [SIG_B]);
    const before = s.audit.length;
    expect(await immediateGate(s.ctx, scopes[0])).toMatchObject({ kind: 'attribution_unknown' });
    expect(s.audit.length).toBe(before);
    expect(await exists(s.rsi)).toBe(false);
  });
});

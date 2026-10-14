import { describe, expect, it } from 'vitest';
import {
  AUTO_SYNC_DECLINE_REASONS,
  AUTO_SYNC_MAX_OPS,
  AdapterMetaSchema,
  DEFAULT_SYNC_AGENTS,
  DOCTOR_CHECK_IDS,
  HOME_WRITE_TABLE,
  NPMJS_REGISTRY,
  PayloadIntegritySchema,
  PayloadManifestSchema,
  SYNC_CHECK_FAILED_REASONS,
  SYNC_FAIL_CLOSED_REASONS,
  SYNC_NOT_RUN_REASONS,
  SYNC_USAGE_REASONS,
  SyncLedgerSchema,
  SyncTxnSchema,
  UPDATE_STABLE_CODES,
  UPDATE_USAGE_REASONS,
  UpdateStateSchema,
  UserConfigSchema,
  isHomeWritePath,
} from '../../src/contracts/index.js';
import { readDir, readText } from '../../src/io/read-fs.js';

const DOC = new URL('../../docs/contracts.md', import.meta.url).pathname;
const ADAPTERS = new URL('../../adapters', import.meta.url).pathname;
const h = (n: number) => n.toString(16).padStart(64, '0');
const TXN = 'txn-20261014T120000Z-a1b2c3';

describe('HOME_WRITE_TABLE', () => {
  it('等于 adapters/*/managed-targets.json 的并集 + 两个本套件目录(含声明方 agent)', async () => {
    const dirs = (await readDir(ADAPTERS)).filter((e) => !e.isFile).map((e) => e.name);
    expect(dirs.length).toBeGreaterThanOrEqual(5);
    const union = new Map<string, string[]>();
    for (const d of dirs) {
      const meta = AdapterMetaSchema.parse(
        JSON.parse(await readText(`${ADAPTERS}/${d}/managed-targets.json`)),
      );
      for (const t of meta.managed_targets) {
        expect(t.startsWith('~/')).toBe(true);
        const rel = t.slice(2);
        union.set(rel, [...(union.get(rel) ?? []), meta.agent].sort());
      }
    }
    const fromTable = new Map(
      HOME_WRITE_TABLE.filter((e) => e.owner === 'adapter').map((e) => [e.path, [...e.agents]]),
    );
    expect(Object.fromEntries(fromTable)).toEqual(Object.fromEntries(union));
    // 目录类条目以 / 结尾,文件类不以 / 结尾
    for (const e of HOME_WRITE_TABLE) expect(e.path.endsWith('/')).toBe(e.kind === 'dir');
    expect(HOME_WRITE_TABLE.filter((e) => e.owner === 'kit').map((e) => e.path)).toEqual([
      '.local/share/agent-kit/',
      '.local/state/agent-kit/',
    ]);
    expect(HOME_WRITE_TABLE.length).toBe(union.size + 2);
  });

  it('按 path 字节序严格升序、无重复', () => {
    const ps = HOME_WRITE_TABLE.map((e) => e.path);
    expect(ps).toEqual([...ps].sort());
    expect(new Set(ps).size).toBe(ps.length);
  });

  it('isHomeWritePath:表内文件放行,目录本身与表外一律拒', () => {
    expect(isHomeWritePath('.claude/skills/x/SKILL.md')).toBe(true);
    expect(isHomeWritePath('.agents/skills/x/SKILL.md', 'adapter')).toBe(true);
    expect(isHomeWritePath('.codex/AGENTS.md')).toBe(true);
    expect(isHomeWritePath('.local/state/agent-kit/sync/ledger.json', 'kit')).toBe(true);
    expect(isHomeWritePath('.local/state/agent-kit/sync/ledger.json', 'adapter')).toBe(false);
    // adapter 目录内部:点开头的路径段与 .json 文件永远不碰
    for (const p of [
      '.agents/skills/.social-hub-skills.json',
      '.claude/skills/x/settings.json',
      '.claude/skills/.hidden/SKILL.md',
      '.claude/rules/agent-kit/.DS_Store',
    ]) {
      expect(isHomeWritePath(p), p).toBe(false);
    }
    // 点目录在 HOME 根下(.claude 等)不受影响;kit 状态目录的 .json 放行
    expect(isHomeWritePath('.claude/rules/agent-kit/org.md')).toBe(true);
    expect(isHomeWritePath('.local/state/agent-kit/update/state.json', 'kit')).toBe(true);
    // 目录本身不可写
    expect(isHomeWritePath('.claude/skills/')).toBe(false);
    expect(isHomeWritePath('.claude/skills')).toBe(false);
    // 用户自己的文件永远不在表内
    for (const p of [
      '.claude/CLAUDE.md',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.codex/config.toml',
      '.codex/AGENTS.override.md',
      '.pi/agent/settings.json',
      '.pi/agent/AGENTS.override.md',
      '.config/agent-kit/config.toml',
      '.claude/skillsX/a/SKILL.md',
      '.codex/AGENTS.md/extra',
    ]) {
      expect(isHomeWritePath(p), p).toBe(false);
    }
    // 路径穿越 / 绝对路径 / ~ / 反斜杠 / NUL / 空段
    for (const p of [
      '.claude/skills/../../.ssh/x',
      '/etc/passwd',
      '~/.claude/skills/x/SKILL.md',
      '.claude\\skills\\x',
      '.claude/skills/x\0',
      '.claude//skills/x',
      '',
    ]) {
      expect(isHomeWritePath(p), JSON.stringify(p)).toBe(false);
    }
  });
});

describe('UserConfig 默认值(决策 ②B / ③A / ⑤A / ⑭B)', () => {
  it('整份缺省与 update 缺省都合法,默认值正确', () => {
    for (const input of [{}, { update: {} }]) {
      const r = UserConfigSchema.parse(input);
      expect(r.update).toEqual({
        auto_install: true,
        auto_sync: 'safe',
        channel: 'latest',
        cooldown_hours: 24,
        registry: NPMJS_REGISTRY,
      });
      expect(r.update.pin).toBeUndefined();
    }
  });

  it('auto_sync 只有 off | safe;可关;pin 与冷却期范围', () => {
    expect(UserConfigSchema.parse({ update: { auto_sync: 'off' } }).update.auto_sync).toBe('off');
    for (const bad of ['full', 'on', 'SAFE', true]) {
      expect(UserConfigSchema.safeParse({ update: { auto_sync: bad } }).success).toBe(false);
    }
    for (const ok of ['0.2.1', '0.2.1-rc.0', '~0.2', '~0.2.1']) {
      expect(UserConfigSchema.safeParse({ update: { pin: ok } }).success, ok).toBe(true);
    }
    for (const bad of ['latest', '^0.2.1', '0.2', '>=0.2.0', '']) {
      expect(UserConfigSchema.safeParse({ update: { pin: bad } }).success, bad).toBe(false);
    }
    for (const c of [1, 24, 720]) {
      expect(UserConfigSchema.safeParse({ update: { cooldown_hours: c } }).success).toBe(true);
    }
    for (const c of [0, -1, 721, 1.5]) {
      expect(UserConfigSchema.safeParse({ update: { cooldown_hours: c } }).success).toBe(false);
    }
  });

  it('registry:只收 https、无用户信息 / 查询 / 片段;未知键被拒(strict)', () => {
    expect(
      UserConfigSchema.safeParse({ update: { registry: 'https://registry.npmmirror.com/' } })
        .success,
    ).toBe(true);
    for (const bad of [
      'http://registry.example.com/',
      'file:///tmp/x',
      'https://u:p@registry.example.com/',
      'https://registry.example.com/?a=1',
      'https://registry.example.com/#x',
      'not a url',
    ]) {
      expect(UserConfigSchema.safeParse({ update: { registry: bad } }).success, bad).toBe(false);
    }
    expect(UserConfigSchema.safeParse({ surprise: 1 }).success).toBe(false);
    expect(UserConfigSchema.safeParse({ update: { mode: 'auto' } }).success).toBe(false);
  });
});

describe('SemverSchema / pin 严格 SemVer', () => {
  it('拒绝前导零、空预发布标识符;接受常规与预发布', () => {
    const ok = (v: string) =>
      UpdateStateSchema.safeParse({ schema_version: 1, latest_seen: v }).success;
    for (const v of ['0.1.0', '1.2.3', '0.1.0-rc.0', '1.2.3-alpha-1', '1.0.0-0.3.7']) {
      expect(ok(v), v).toBe(true);
    }
    for (const v of [
      '01.2.3',
      '1.02.3',
      '1.2.3-',
      '1.2.3-.',
      '1.2.3-rc..1',
      '1.2.3-01',
      'v1.2.3',
      '1.2.3+b',
    ]) {
      expect(ok(v), v).toBe(false);
    }
    const pin = (v: string) => UserConfigSchema.safeParse({ update: { pin: v } }).success;
    expect(pin('~0.2')).toBe(true);
    for (const v of ['01.2.3', '1.2.3-rc..1', '~01.2', '~0.2.', '1.2.3-01']) {
      expect(pin(v), v).toBe(false);
    }
  });
});

describe('UpdateState', () => {
  it('只有 schema_version 即合法,bad_versions 缺省为空', () => {
    const r = UpdateStateSchema.parse({ schema_version: 1 });
    expect(r.bad_versions).toEqual([]);
  });

  it('last_result:枚举或 http_<码>;笼统的 network_error 被拒', () => {
    for (const ok of ['ok', 'timeout', 'dns', 'attestations_unreachable', 'http_503']) {
      expect(UpdateStateSchema.safeParse({ schema_version: 1, last_result: ok }).success, ok).toBe(
        true,
      );
    }
    for (const bad of ['network_error', 'http_99', 'http_700', 'HTTP_503']) {
      expect(
        UpdateStateSchema.safeParse({ schema_version: 1, last_result: bad }).success,
        bad,
      ).toBe(false);
    }
  });

  it('last_auto_sync:applied 需 txn_id 且无原因;declined 需原因且不重复', () => {
    const base = { at: '2026-10-12T09:30:00Z', add: 0, update: 1, remove: 0 };
    const ok = (v: object) =>
      UpdateStateSchema.safeParse({ schema_version: 1, last_auto_sync: { ...base, ...v } }).success;
    expect(ok({ outcome: 'applied', txn_id: TXN })).toBe(true);
    expect(ok({ outcome: 'applied' })).toBe(false);
    expect(ok({ outcome: 'applied', txn_id: TXN, reasons: ['drifted'] })).toBe(false);
    expect(ok({ outcome: 'declined', reasons: ['drifted', 'must_atom'] })).toBe(true);
    expect(ok({ outcome: 'declined' })).toBe(false);
    expect(ok({ outcome: 'declined', reasons: ['drifted', 'drifted'] })).toBe(false);
    expect(ok({ outcome: 'declined', reasons: ['whatever'] })).toBe(false);
  });

  it('strict:未知键被拒', () => {
    expect(UpdateStateSchema.safeParse({ schema_version: 1, extra: 1 }).success).toBe(false);
  });
});

describe('SyncLedger / SyncTxn', () => {
  const entry = (path: string, extra: object = {}) => ({
    path,
    kind: 'owned',
    sha256: h(2),
    created_file: true,
    agents: ['claude'],
    txn: TXN,
    ...extra,
  });
  const ledger = (entries: object[]) => ({
    schema_version: 1,
    kit_version: '0.1.0',
    payload_sha256: h(1),
    entries,
  });

  it('空登记表合法;未知键被拒;排序与唯一', () => {
    expect(SyncLedgerSchema.safeParse(ledger([])).success).toBe(true);
    expect(SyncLedgerSchema.safeParse({ ...ledger([]), x: 1 }).success).toBe(false);
    const a = entry('.claude/skills/a/SKILL.md');
    const b = entry('.claude/skills/b/SKILL.md');
    expect(SyncLedgerSchema.safeParse(ledger([a, b])).success).toBe(true);
    expect(SyncLedgerSchema.safeParse(ledger([b, a])).success).toBe(false);
    expect(SyncLedgerSchema.safeParse(ledger([a, a])).success).toBe(false);
  });

  it('表外路径、owned 带 block_id、block 缺 block_id、agents 为空 / 重复均被拒', () => {
    const ok = (e: object) => SyncLedgerSchema.safeParse(ledger([e])).success;
    expect(ok(entry('.claude/skills/a/SKILL.md'))).toBe(true);
    expect(ok(entry('.claude/CLAUDE.md'))).toBe(false);
    expect(ok(entry('.local/state/agent-kit/sync/ledger.json'))).toBe(false);
    expect(ok(entry('.claude/skills/a/SKILL.md', { block_id: 'agent-kit-rules' }))).toBe(false);
    expect(ok(entry('.codex/AGENTS.md', { kind: 'block' }))).toBe(false);
    expect(ok(entry('.codex/AGENTS.md', { kind: 'block', block_id: 'agent-kit-rules' }))).toBe(
      true,
    );
    expect(ok(entry('.claude/skills/a/SKILL.md', { agents: [] }))).toBe(false);
    expect(ok(entry('.claude/skills/a/SKILL.md', { agents: ['claude', 'claude'] }))).toBe(false);
    expect(ok(entry('.claude/skills/a/SKILL.md', { txn: 'txn-1' }))).toBe(false);
  });

  const op = (o: object) => ({
    op: 'create',
    path: '.claude/skills/a/SKILL.md',
    file_sha256_before: null,
    file_sha256_after: h(2),
    backup: false,
    agents: ['claude'],
    ...o,
  });
  const txn = (ops: object[], extra: object = {}) => ({
    schema_version: 1,
    txn_id: TXN,
    action: 'sync',
    kit_version: '0.1.0',
    payload_sha256: h(1),
    ledger_sha256_before: null,
    started_at: '2026-10-14T12:00:00Z',
    phase: 'planned',
    ops,
    ...extra,
  });
  const okTxn = (ops: object[], extra: object = {}) =>
    SyncTxnSchema.safeParse(txn(ops, extra)).success;

  it('各操作的写前 / 写后 / 备份约束', () => {
    expect(okTxn([op({})])).toBe(true);
    expect(okTxn([])).toBe(false);
    // create:写前必须 null
    expect(okTxn([op({ file_sha256_before: h(3), backup: true })])).toBe(false);
    // update:写前写后都非 null、不同,且必须备份
    const upd = { op: 'update', file_sha256_before: h(3), file_sha256_after: h(4), backup: true };
    expect(okTxn([op(upd)])).toBe(true);
    expect(okTxn([op({ ...upd, backup: false })])).toBe(false);
    expect(okTxn([op({ ...upd, file_sha256_after: h(3) })])).toBe(false);
    // remove
    const rm = { op: 'remove', file_sha256_before: h(3), file_sha256_after: null, backup: true };
    expect(okTxn([op(rm)])).toBe(true);
    expect(okTxn([op({ ...rm, file_sha256_after: h(4) })])).toBe(false);
    // block_*:必须带 block_id;普通操作不得带
    const blk = {
      op: 'block_upsert',
      path: '.codex/AGENTS.md',
      block_id: 'agent-kit-rules',
      file_sha256_before: null,
      file_sha256_after: h(5),
      backup: false,
      agents: ['codex'],
    };
    expect(okTxn([op(blk)])).toBe(true);
    expect(okTxn([op({ ...blk, block_id: undefined })])).toBe(false);
    expect(okTxn([op({ block_id: 'agent-kit-rules' })])).toBe(false);
    expect(
      okTxn([
        op({
          ...blk,
          op: 'block_remove',
          file_sha256_before: h(5),
          file_sha256_after: null,
          backup: true,
        }),
      ]),
    ).toBe(true);
  });

  it('rollback_of / payload_sha256 / 排序 / overwrote_drifted 缺省', () => {
    expect(okTxn([op({})], { action: 'rollback', payload_sha256: undefined })).toBe(false);
    expect(
      okTxn([op({})], {
        action: 'rollback',
        rollback_of: 'txn-20261013T000000Z-ffffff',
        payload_sha256: undefined,
      }),
    ).toBe(true);
    expect(okTxn([op({})], { rollback_of: TXN })).toBe(false);
    expect(okTxn([op({})], { payload_sha256: undefined })).toBe(false);
    const a = op({ path: '.claude/skills/a/SKILL.md' });
    const b = op({ path: '.claude/skills/b/SKILL.md' });
    expect(okTxn([a, b])).toBe(true);
    expect(okTxn([b, a])).toBe(false);
    expect(okTxn([a, a])).toBe(false);
    expect(SyncTxnSchema.parse(txn([a])).ops[0]?.overwrote_drifted).toBe(false);
    // 写前登记表哈希必须显式给出(null = 写前没有登记表)
    expect(okTxn([a], { ledger_sha256_before: h(9) })).toBe(true);
    expect(okTxn([a], { ledger_sha256_before: undefined })).toBe(false);
  });
});

describe('PayloadManifest / PayloadIntegrity', () => {
  const file = (agent: string, path: string, extra: object = {}) => ({
    agent,
    target: 'home',
    path,
    mode: 'owned',
    kind: 'skill',
    confidence: 'documented',
    sha256: h(2),
    bytes: 10,
    payload_path: `files/${agent}/home/${path}`,
    atoms: [],
    ...extra,
  });
  const manifest = (files: object[]) => ({
    schema_version: 1,
    kit_version: '0.1.0',
    channel: 'stable',
    files,
    skippedLayers: [],
  });
  const ok = (files: object[]) => PayloadManifestSchema.safeParse(manifest(files)).success;

  it('缺省 migrations 为空;空文件表合法;排序与唯一;表外路径被拒', () => {
    expect(PayloadManifestSchema.parse(manifest([])).migrations).toEqual([]);
    const a = file('claude', '.claude/skills/a/SKILL.md');
    const b = file('codex', '.agents/skills/a/SKILL.md');
    expect(ok([a, b])).toBe(true);
    expect(ok([b, a])).toBe(false);
    expect(ok([a, a])).toBe(false);
    expect(ok([file('claude', '.claude/settings.json')])).toBe(false);
    expect(ok([file('claude', '.claude/skills/')])).toBe(false);
    // project 目标不受 HOME 表约束
    expect(ok([file('claude', 'AGENTS.md', { target: 'project' })])).toBe(true);
  });

  it('managed-block 与 block_id 成对;strength 只有 must / should', () => {
    const blk = file('codex', '.codex/AGENTS.md', {
      mode: 'managed-block',
      kind: 'rules',
      block_id: 'agent-kit-rules',
      atoms: [{ id: 'a-rule', layer: 'org', strength: 'must' }],
    });
    expect(ok([blk])).toBe(true);
    expect(ok([{ ...blk, block_id: undefined }])).toBe(false);
    expect(ok([file('claude', '.claude/skills/a/SKILL.md', { block_id: 'agent-kit-rules' })])).toBe(
      false,
    );
    expect(ok([{ ...blk, atoms: [{ id: 'a-rule', layer: 'org', strength: 'could' }] }])).toBe(
      false,
    );
    expect(ok([{ ...blk, kind: 'hook' }])).toBe(false);
  });

  const integ = (files: object[]) => ({
    schema_version: 1,
    kit_version: '0.1.0',
    algorithm: 'sha256',
    files,
  });
  const f = (path: string) => ({ path, sha256: h(7), bytes: 1 });
  it('integrity:升序唯一、不含自身、相对路径', () => {
    const okI = (files: object[]) => PayloadIntegritySchema.safeParse(integ(files)).success;
    expect(okI([f('a'), f('b/c')])).toBe(true);
    expect(okI([f('b'), f('a')])).toBe(false);
    expect(okI([f('a'), f('a')])).toBe(false);
    expect(okI([f('integrity.json')])).toBe(false);
    expect(okI([f('../x')])).toBe(false);
    expect(okI([f('/x')])).toBe(false);
    expect(PayloadIntegritySchema.safeParse({ ...integ([]), algorithm: 'md5' }).success).toBe(
      false,
    );
  });
});

describe('§19 文档与常量一致', () => {
  it('每个稳定码 / 原因码 / 检查 id / 缺省 agent 集合都出现在 docs/contracts.md', async () => {
    const md = await readText(DOC);
    const sec = md.slice(md.indexOf('## 19. sync / doctor / update'));
    expect(sec.length).toBeGreaterThan(1000);
    const all: string[] = [
      ...SYNC_USAGE_REASONS,
      ...SYNC_CHECK_FAILED_REASONS,
      ...SYNC_NOT_RUN_REASONS,
      ...SYNC_FAIL_CLOSED_REASONS,
      ...UPDATE_STABLE_CODES,
      ...UPDATE_USAGE_REASONS,
      ...AUTO_SYNC_DECLINE_REASONS,
      ...DOCTOR_CHECK_IDS,
      ...HOME_WRITE_TABLE.map((e) => e.path),
      ...DEFAULT_SYNC_AGENTS,
    ];
    for (const c of all) expect(sec, c).toContain(c);
    expect(sec).toContain(`AUTO_SYNC_MAX_OPS\`(${AUTO_SYNC_MAX_OPS})`);
  });
});

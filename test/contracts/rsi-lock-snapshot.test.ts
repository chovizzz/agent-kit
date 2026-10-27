/**
 * R20 A1:`RsiSnapshot` / `RsiLockDoc` 的合法 / 错误示例矩阵(contracts §20.5、§20.8.2「R20」行),稳定码枚举与 docs/contracts.md §20.3 总表一致。
 * 示例放在测试里而不是文档的 `<!-- example: -->` 标记块:§20 的 JSON 是说明性的,schema 全部落地(A2)后再统一登记。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_FAIL_CLOSED_REASONS,
  RSI_NOT_RUN_REASONS,
  RSI_SNAPSHOT_BUSY,
  RSI_SNAPSHOT_MAX_FILES,
  RsiLockDocSchema,
  RsiSnapshotSchema,
  isRsiSnapshotName,
} from '../../src/contracts/rsi.js';
import { readText } from '../../src/io/read-fs.js';

const H = (c: string): string => c.repeat(64);
const snap = (files: unknown[], over: Record<string, unknown> = {}): unknown => ({
  schema_version: 1,
  generation: 3,
  written_at: '2026-10-23T12:00:00.000Z',
  files,
  ...over,
});
const f = (name: string, bytes = 10, sha256 = H('a')): unknown => ({ name, sha256, bytes });

describe('RsiSnapshot(R20-5.6)', () => {
  const valid: [string, unknown][] = [
    ['空清单', snap([])],
    [
      '固定名 + 月文件,升序',
      snap([
        f('counts.json'),
        f('sessions/pi/202609.jsonl'),
        f('signals/claude/202610.jsonl'),
        f('state.json', 0),
      ]),
    ],
    ['四个固定名', snap([f('counts.json'), f('cursor.json'), f('projects.json'), f('state.json')])],
    [
      '恰 2000 项',
      snap(Array.from({ length: 2000 }, (_, i) => f(`signals/claude/${String(100000 + i)}.jsonl`))),
    ],
  ];
  for (const [name, v] of valid) {
    it(`合法:${name}`, () => {
      expect(RsiSnapshotSchema.safeParse(v).success).toBe(true);
    });
  }

  // 断言「状态、阻断范围、原因码」三者:状态=snapshot 清单不可用;阻断=持锁写入方的提交与所有只读方的核对;原因码=snapshot_invalid
  const invalid: [string, unknown][] = [
    ['name 不在白名单:路径穿越', snap([f('../state.json')])],
    ['name 不在白名单:绝对路径', snap([f('/etc/passwd')])],
    ['name 不在白名单:log.jsonl', snap([f('log.jsonl')])],
    ['name 不在白名单:盐', snap([f('salt')])],
    ['name 不在白名单:未知 agent', snap([f('signals/kimi/202610.jsonl')])],
    ['name 不在白名单:月份不是 6 位', snap([f('signals/claude/20261.jsonl')])],
    ['name 不在白名单:多一层目录', snap([f('signals/claude/x/202610.jsonl')])],
    ['name 重复', snap([f('state.json'), f('state.json')])],
    ['name 未按字节序升序', snap([f('state.json'), f('counts.json')])],
    [
      '2001 项',
      snap(Array.from({ length: 2001 }, (_, i) => f(`signals/claude/${String(100000 + i)}.jsonl`))),
    ],
    ['generation 为 0', snap([], { generation: 0 })],
    ['generation 为负', snap([], { generation: -1 })],
    ['generation 非整数', snap([], { generation: 1.5 })],
    ['schema_version 不是 1', snap([], { schema_version: 2 })],
    ['sha256 不是 64 位小写十六进制', snap([f('state.json', 1, 'A'.repeat(64))])],
    ['bytes 为负', snap([f('state.json', -1)])],
    ['多余字段', snap([], { extra: 1 })],
    ['文件项多余字段', snap([{ name: 'state.json', sha256: H('a'), bytes: 1, mtime: 1 }])],
    ['缺 written_at', { schema_version: 1, generation: 1, files: [] }],
  ];
  for (const [name, v] of invalid) {
    it(`错误:${name}`, () => {
      expect(RsiSnapshotSchema.safeParse(v).success).toBe(false);
    });
  }

  it('常量:上限 2000;白名单判定函数与 schema 一致', () => {
    expect(RSI_SNAPSHOT_MAX_FILES).toBe(2000);
    expect(isRsiSnapshotName('state.json')).toBe(true);
    expect(isRsiSnapshotName('sessions/codex/202610.jsonl')).toBe(true);
    for (const bad of [
      '',
      '../x',
      'signals/kimi/202610.jsonl',
      'lock',
      'snapshot.json',
      'signals/claude/202610.jsonl\n',
    ]) {
      expect(isRsiSnapshotName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('RsiLockDoc(R20-5.5)', () => {
  const ok = {
    pid: 12,
    started_at: '2026-10-23T12:00:00.000Z',
    nonce: 'ab'.repeat(8),
    kit_version: '0.1.0',
  };
  it('合法', () => expect(RsiLockDocSchema.safeParse(ok).success).toBe(true));
  for (const [name, v] of [
    ['pid 为 0(会被当成进程组)', { ...ok, pid: 0 }],
    ['pid 为负(进程组)', { ...ok, pid: -5 }],
    ['pid 非整数', { ...ok, pid: 1.5 }],
    ['nonce 长度不对', { ...ok, nonce: 'abc' }],
    ['缺 kit_version', { pid: 1, started_at: ok.started_at, nonce: ok.nonce }],
    ['started_at 不是时间戳', { ...ok, started_at: 'yesterday' }],
    ['多余字段', { ...ok, owner: 'x' }],
  ] as [string, unknown][]) {
    it(`错误:${name}`, () => expect(RsiLockDocSchema.safeParse(v).success).toBe(false));
  }
});

describe('稳定码枚举与 docs/contracts.md §20.3 总表一致(R20-3.0)', async () => {
  const md = await readText(new URL('../../docs/contracts.md', import.meta.url).pathname);
  const rowCodes = (head: string): string[] => {
    const row = md.split('\n').find((l) => l.startsWith(`| ${head}`));
    if (row === undefined) throw new Error(`总表缺行 ${head}`);
    const cell = row.split('|')[2] ?? '';
    return [...cell.matchAll(/`([a-z_:A-Z]+)`/g)].map((m) => m[1] as string);
  };
  it('RSI_NOT_RUN reason', () => {
    expect([...RSI_NOT_RUN_REASONS].sort()).toEqual(rowCodes('`RSI_NOT_RUN reason=`').sort());
  });
  it('RSI_FAIL_CLOSED reason', () => {
    // `staging_unsafe_entry`(B3c-7)已进枚举、文档总表待并入:差集由 test/contracts/rsi-codes-table.test.ts 的待并入清单精确管理
    expect([...RSI_FAIL_CLOSED_REASONS].filter((c) => c !== 'staging_unsafe_entry').sort()).toEqual(
      rowCodes('`RSI_FAIL_CLOSED reason=`').sort(),
    );
  });
  it('顶层 RSI_SNAPSHOT_BUSY(退出 4)', () => {
    expect(rowCodes('顶层(4)')).toEqual([RSI_SNAPSHOT_BUSY]);
  });
});

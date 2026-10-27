/**
 * R20-A2 B2:流式快照接口(月文件流式、固定文件整份)、inspect / recover 拆分、快路径语义、生产校验器。
 * 对应 a2-plan v2 §4;A1 的恢复 / 读取测试在 snapshot.test.ts / safe-read.test.ts。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../src/contracts/signal.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, lstat, readBytes, readDir, readText } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { acquireRsiLock, type RsiLockHandle } from '../../src/rsi/lock.js';
import {
  RsiSnapshotError,
  type SnapshotReadHooks,
  commitSnapshot,
  inspectSnapshot,
  readSnapshot,
  recoverSnapshot,
} from '../../src/rsi/snapshot.js';
import { parseRsiStateDoc } from '../../src/rsi/state.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { signalLine } from '../../src/signals/state-store.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { newWork, type Work } from '../signals/helpers.js';
import { mkfifo } from './proc/helper.js';
import { structuralValidator } from './structural-validator.js';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const rsiFile = (w: Work, n: string): string => path.join(w.state, 'rsi', n);
const snapFile = (w: Work): string => rsiFile(w, 'snapshot.json');
const absOf = (w: Work, rel: string): string =>
  rel.includes('/') ? path.join(w.state, rel) : rsiFile(w, rel);

function sig(id: string, excerpt = 'hello'): Signal {
  return {
    sig_id: `sig_${id.padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '1.0.0',
    agent_version_source: 'session_meta',
    session_ref: 's_0123456789abcdef',
    project_key: 'p_0123456789abcdef',
    ts: '2026-10-01T00:00:00.000Z',
    type: 'event',
    excerpt_redacted: excerpt,
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
  };
}

async function put(w: Work, rel: string, text: string, m = 0o600): Promise<void> {
  const abs = absOf(w, rel);
  await mkdirp(w.io, path.dirname(abs), 0o700);
  await writeFile(w.io, abs, text, { mode: m });
}

async function withLock<T>(w: Work, fn: (l: RsiLockHandle) => Promise<T>): Promise<T> {
  const l = await acquireRsiLock(w.io);
  try {
    return await fn(l);
  } finally {
    await l.release();
  }
}

// 合法的生产形状文件
const H = (c: string): string => c.repeat(64);
const STATE_OK = JSON.stringify({
  schema_version: 1,
  confirm: null,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 0,
  breaker: null,
});
const COUNTS_OK = JSON.stringify({
  schema_version: 1,
  salt_fp: '3f2a9c1d7e4b',
  generation: 1,
  computed_at: '2026-10-24T08:00:00.000Z',
  cluster_min: 3,
  per_key: {},
  clusters: [],
  staged: [],
  unknown_keys_signals: 0,
});
const CURSOR_OK = JSON.stringify({
  schema_version: 1,
  fingerprint: H('d'),
  full_scan: { epoch: 0, started_at: null, done: false, last_completed_at: null },
  files: {},
});
const MONTH = 'signals/claude/202610.jsonl';

async function productionCommitted(prefix: string): Promise<Work> {
  const w = await newWork(prefix);
  await put(w, 'state.json', STATE_OK);
  await put(w, 'counts.json', COUNTS_OK);
  await put(w, 'cursor.json', CURSOR_OK);
  await put(w, MONTH, `${signalLine(sig('1'))}\n`);
  await withLock(w, (l) => commitSnapshot(w.io, l));
  return w;
}

describe('月文件流式:摘要 / 字节数对应原始字节', () => {
  it('commit 的 sha256 与字节数 = 磁盘原始字节的(含 CRLF 行尾与多字节字符;不是归一化文本的)', async () => {
    const w = await newWork('ss-raw-');
    const raw = `${JSON.stringify(sig('1', 'é你好'))}\r\n${JSON.stringify(sig('2', 'x'))}\n`;
    await put(w, MONTH, raw);
    const s = await withLock(w, (l) => commitSnapshot(w.io, l, { chunkBytes: 7 }));
    const f = s.files.find((x) => x.name === MONTH);
    expect(f).toEqual({ name: MONTH, sha256: sha(raw), bytes: Buffer.byteLength(raw) });
    expect(sha(raw.replace(/\r\n/g, '\n'))).not.toBe(f?.sha256);
    // 恢复时(换块大小)同一份字节得到同一摘要:consistent
    expect(
      await withLock(w, (l) => recoverSnapshot(w.io, l, structuralValidator, { chunkBytes: 3 })),
    ).toBe('consistent');
  });

  it('月文件不受固定文件的载入上限约束:超过(注入的)固定上限的月文件通过,同样大小的固定文件按损坏处理', async () => {
    const w = await newWork('ss-nolimit-');
    const big = Array.from({ length: 50 }, (_, i) => signalLine(sig(String(i)))).join('\n') + '\n';
    expect(big.length).toBeGreaterThan(2048);
    await put(w, MONTH, big);
    await put(w, 'state.json', '{}');
    const cap = { maxFixedBytes: 2048 };
    const s = await withLock(w, (l) => commitSnapshot(w.io, l, cap));
    expect(s.files.find((x) => x.name === MONTH)?.bytes).toBe(Buffer.byteLength(big));
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, structuralValidator, cap))).toBe(
      'consistent',
    );
    // 对照:固定文件超过同一个上限 → 该文件损坏
    await put(w, 'counts.json', `{"pad":"${'x'.repeat(4096)}"}`);
    await expect(withLock(w, (l) => commitSnapshot(w.io, l, cap))).rejects.toMatchObject({
      reason: 'counts_invalid',
    });
  });

  it('一次打开:同一遍扫描里,一个月文件只被打开一次(摘要与校验是同一次读取;变异:分两次打开 → 红)', async () => {
    const w = await newWork('ss-oneopen-');
    await put(w, 'state.json', STATE_OK);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await put(w, MONTH, `${signalLine(sig('1'))}\n`);
    const opens: string[] = [];
    // commit:每个文件一次
    await withLock(w, (l) =>
      commitSnapshot(w.io, l, {
        beforeOpen: (f) => void (f.endsWith('202610.jsonl') && opens.push('month')),
      }),
    );
    expect(opens).toEqual(['month']);
    // recover(一致 → 一遍;不一致 → 两遍,第二遍摘要 + 校验仍是同一次打开):month 一共两次,不是三次
    opens.length = 0;
    await put(w, MONTH, `${signalLine(sig('1'))}\n${signalLine(sig('2'))}\n`);
    expect(
      await withLock(w, (l) =>
        recoverSnapshot(w.io, l, structuralValidator, {
          beforeOpen: (f) => void (f.endsWith('202610.jsonl') && opens.push('month')),
        }),
      ),
    ).toBe('rebuilt');
    expect(opens).toEqual(['month', 'month']);
  });

  it('月文件跨块 UTF-8:每个小块大小下 recover 结论一致', async () => {
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const w2 = await newWork('ss-utf8b-');
      await put(w2, MONTH, `${signalLine(sig('1', '你好,世界 😀 é'))}\n`);
      expect(
        await withLock(w2, (l) =>
          recoverSnapshot(w2.io, l, productionSnapshotValidator, { chunkBytes: n }),
        ),
        `chunk=${n}`,
      ).toBe('absent');
    }
  });

  it('缺尾换行 / 超长行 / 非 JSON / 非 UTF-8 的月文件 → signal_store_corrupt,清单不被改写(变异:缺尾换行放行 → 红)', async () => {
    const good = `${signalLine(sig('1'))}\n`;
    const bads: [string, Buffer | string, Partial<SnapshotReadHooks>?][] = [
      ['缺尾换行', `${signalLine(sig('1'))}\n${JSON.stringify(sig('2'))}`],
      ['超长行', good, { maxLineBytes: 10 }],
      ['空行', `${signalLine(sig('1'))}\n\n`],
      ['非 JSON', 'garbage\n'],
      ['非法 UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x0a])],
    ];
    for (const [name, content, hooks] of bads) {
      const w = await newWork('ss-badmonth-');
      await put(w, 'state.json', STATE_OK);
      await withLock(w, (l) => commitSnapshot(w.io, l));
      const before = await readText(snapFile(w));
      await mkdirp(w.io, path.join(w.state, 'signals/claude'), 0o700);
      await writeFile(w.io, path.join(w.state, MONTH), content, { mode: 0o600 });
      const e = await withLock(w, (l) =>
        recoverSnapshot(w.io, l, productionSnapshotValidator, hooks ?? {}),
      ).catch((x: unknown) => x);
      expect(e, name).toBeInstanceOf(RsiSnapshotError);
      expect((e as RsiSnapshotError).reason, name).toBe('signal_store_corrupt');
      expect(await readText(snapFile(w)), name).toBe(before);
    }
  });

  it('月文件中途被换:检查之后、打开之前换成符号链接 / FIFO / 硬链接 → 损坏,不跟随、不挂住', async () => {
    for (const mode of ['symlink', 'fifo', 'hardlink'] as const) {
      const w = await newWork('ss-swap-');
      await put(w, 'state.json', STATE_OK);
      await put(w, MONTH, `${signalLine(sig('1'))}\n`);
      await withLock(w, (l) => commitSnapshot(w.io, l));
      await put(w, 'counts.json', COUNTS_OK); // 让清单不一致,走第二遍
      const file = path.join(w.state, MONTH);
      const target = path.join(w.dir, 'target.jsonl');
      await writeFile(w.io, target, `${signalLine(sig('9'))}\n`, { mode: 0o600 });
      let swapped = false;
      const e = await withLock(w, (l) =>
        recoverSnapshot(w.io, l, productionSnapshotValidator, {
          beforeOpen: async (f) => {
            if (f !== file || swapped) return;
            swapped = true;
            await remove(w.io, file);
            if (mode === 'symlink') await symlink(w.io, target, file);
            else if (mode === 'fifo') mkfifo(file);
            else {
              await writeFile(w.io, file, `${signalLine(sig('1'))}\n`, { mode: 0o600 });
              await hardlink(w.io, file, path.join(w.dir, 'alias.jsonl'));
            }
          },
        }),
      ).catch((x: unknown) => x);
      expect(e, mode).toBeInstanceOf(RsiSnapshotError);
      expect((e as RsiSnapshotError).reason, mode).toBe('signal_store_corrupt');
    }
  });

  it('校验器在流式读取中途抛错:句柄被关(之后同一路径可正常删除 / 重建,重复多次不累积泄漏)', async () => {
    const w = await newWork('ss-throw-');
    await put(
      w,
      MONTH,
      Array.from({ length: 200 }, (_, i) => signalLine(sig(String(i)))).join('\n') + '\n',
    );
    for (let i = 0; i < 40; i++) {
      const e = await withLock(w, (l) =>
        recoverSnapshot(
          w.io,
          l,
          {
            fixed: () => true,
            record: () => {
              throw new Error('validator bug');
            },
          },
          { chunkBytes: 64 },
        ),
      ).catch((x: unknown) => x);
      // 校验器自身抛错也 fail-closed 为该文件损坏
      expect((e as RsiSnapshotError).reason).toBe('signal_store_corrupt');
    }
    await remove(w.io, path.join(w.state, MONTH));
    expect(await exists(path.join(w.state, MONTH))).toBe(false);
  });
});

describe('快路径语义:consistent / absent 不绕过校验', () => {
  it('consistent:固定文件仍整体校验——清单一致但 state.json 过不了 schema → state_invalid(生产校验器);结构校验器放行作对照', async () => {
    const w = await newWork('fp-consistent-');
    await put(w, 'state.json', '{}'); // 形状合法的损坏
    await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, structuralValidator))).toBe(
      'consistent',
    );
    await expect(
      withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'state_invalid' });
    await expect(inspectSnapshot(w.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'state_invalid',
    });
  });

  it('state.json 的两套判定一致(真实组合):只有 confirm 不合规 = 状态(armed/schema,快照校验放行,可重新确认);整份不合规 = 损坏(state_invalid)', async () => {
    const confirmOnly = JSON.stringify({
      ...JSON.parse(STATE_OK),
      confirm: { confirmed_at: 'yesterday' },
    });
    const w = await newWork('fp-state-combo-');
    await put(w, 'state.json', confirmOnly);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    // 同一份磁盘字节:状态解析器与生产快照校验器给出相容的结论
    const onDisk = await readBytes(rsiFile(w, 'state.json'));
    expect(parseRsiStateDoc(onDisk).kind).toBe('confirm_schema_invalid');
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('consistent');
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator))).toBe(
      'consistent',
    );
    // 对照:整份损坏 → 两边都判坏
    const w2 = await newWork('fp-state-combo-bad-');
    await put(
      w2,
      'state.json',
      JSON.stringify({ ...JSON.parse(STATE_OK), consecutive_failures: -1 }),
    );
    await withLock(w2, (l) => commitSnapshot(w2.io, l));
    expect(parseRsiStateDoc(await readBytes(rsiFile(w2, 'state.json'))).kind).toBe('invalid');
    await expect(inspectSnapshot(w2.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'state_invalid',
    });
  });

  it('consistent:cursor / counts 同样过 schema(各自原因码)', async () => {
    for (const [file, reason] of [
      ['cursor.json', 'cursor_invalid'],
      ['counts.json', 'counts_invalid'],
    ] as const) {
      const w = await newWork('fp-consistent2-');
      await put(w, 'state.json', STATE_OK);
      await put(w, file, '{"x":1}');
      await withLock(w, (l) => commitSnapshot(w.io, l));
      await expect(
        withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator)),
      ).rejects.toMatchObject({ reason });
    }
  });

  it('absent(清单缺失)≠ 目录为空:空目录 / 只有合法数据 → absent;已有数据里有损坏 → 抛,不当空', async () => {
    const empty = await newWork('fp-absent-empty-');
    expect(
      await withLock(empty, (l) => recoverSnapshot(empty.io, l, productionSnapshotValidator)),
    ).toBe('absent');
    // 此前手动 collect 留下的合法月文件(没有任何固定文件):不是错误
    const legacy = await newWork('fp-absent-legacy-');
    await put(legacy, MONTH, `${signalLine(sig('1'))}\n`);
    expect(
      await withLock(legacy, (l) => recoverSnapshot(legacy.io, l, productionSnapshotValidator)),
    ).toBe('absent');
    // 对照:同样没有清单,但月文件损坏 → 抛 signal_store_corrupt(变异:absent 不校验就放行 → 红)
    const bad = await newWork('fp-absent-bad-');
    await put(bad, MONTH, 'garbage\n');
    await expect(
      withLock(bad, (l) => recoverSnapshot(bad.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'signal_store_corrupt' });
    const badState = await newWork('fp-absent-badstate-');
    await put(badState, 'state.json', '{"nope":1}');
    await expect(
      withLock(badState, (l) => recoverSnapshot(badState.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'state_invalid' });
  });

  it('「必需文件」只对清单列出的文件成立:清单列着的 state / cursor / counts / 月文件缺失 = 损坏;projects.json 缺失放行(D5)', async () => {
    for (const [rel, reason] of [
      ['state.json', 'state_invalid'],
      ['cursor.json', 'cursor_invalid'],
      ['counts.json', 'counts_invalid'],
      [MONTH, 'signal_store_corrupt'],
    ] as const) {
      const w = await productionCommitted('fp-required-');
      const before = await readText(snapFile(w));
      await remove(w.io, absOf(w, rel));
      await expect(
        withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator)),
        rel,
      ).rejects.toMatchObject({ reason });
      expect(await readText(snapFile(w)), rel).toBe(before);
    }
    const w = await productionCommitted('fp-required-projects-');
    await put(w, 'projects.json', '{"anything":true}');
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await remove(w.io, rsiFile(w, 'projects.json'));
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator))).toBe(
      'rebuilt',
    );
  });

  it('D4:projects.json 的内容问题不阻断;读取层的安全问题(权限 / 硬链接 / 链接)照旧阻断', async () => {
    for (const bad of ['[]', 'not json', '{"schema_version":2}', '"s"']) {
      const w = await productionCommitted('d4-content-');
      await put(w, 'projects.json', bad);
      expect(
        await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator)),
        bad,
      ).toBe('rebuilt');
    }
    const perm = await productionCommitted('d4-perm-');
    await put(perm, 'projects.json', '[]');
    await chmod(perm.io, rsiFile(perm, 'projects.json'), 0o644);
    await expect(
      withLock(perm, (l) => recoverSnapshot(perm.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
    const hl = await productionCommitted('d4-hardlink-');
    await put(hl, 'projects.json', '[]');
    await hardlink(hl.io, rsiFile(hl, 'projects.json'), path.join(hl.state, 'alias'));
    await expect(
      withLock(hl, (l) => recoverSnapshot(hl.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
    const lk = await productionCommitted('d4-link-');
    await put(lk, 'real.json', '[]');
    await symlink(lk.io, rsiFile(lk, 'real.json'), rsiFile(lk, 'projects.json'));
    await expect(
      withLock(lk, (l) => recoverSnapshot(lk.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
  });

  it('生产校验器:合法的完整数据集 → consistent / rebuilt;月文件记录过 SignalSchema / SessionStatSchema', async () => {
    const w = await productionCommitted('prod-ok-');
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator))).toBe(
      'consistent',
    );
    await put(w, MONTH, `${signalLine(sig('1'))}\n${signalLine(sig('2'))}\n`);
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator))).toBe(
      'rebuilt',
    );
    await put(w, 'sessions/codex/202610.jsonl', '{"not":"a session stat"}\n');
    await expect(
      withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator)),
    ).rejects.toMatchObject({ reason: 'signal_store_corrupt' });
  });
});

async function tree(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readDir(path.join(root, rel));
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory) {
      const st = await lstat(path.join(root, r));
      out.push(`${r}/ ${(st.mode & 0o777).toString(8)}`);
      out.push(...(await tree(root, r)));
    } else if (e.isSymbolicLink) out.push(`${r} -> link`);
    else out.push(`${r} ${sha(await readBytes(path.join(root, r))).slice(0, 12)}`);
  }
  return out;
}

describe('inspectSnapshot:只读检查', () => {
  async function auditedWork(
    prefix: string,
  ): Promise<{ w: Work; a: ReturnType<typeof withWriteAudit> }> {
    const w = await newWork(prefix);
    const a = withWriteAudit();
    const io = createIoContext({
      cwd: REPO_ROOT,
      env: {
        KIT_TMP: w.dir,
        KIT_STATE_DIR: w.state,
        PATH: '/usr/bin:/bin',
      },
      writeAudit: a.hook,
    });
    return { w: { ...w, io }, a };
  }

  it('状态目录不存在 → absent,不建任何目录;零写入(审计桩 0 次 + 前后快照一致)', async () => {
    const { w, a } = await auditedWork('in-nodir-');
    expect(await exists(w.state)).toBe(false);
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('absent');
    expect(await exists(w.state)).toBe(false);
    expect(a.calls).toEqual([]);
  });

  it('absent / consistent / needs_rebuild 三种结论;临时清单原样留着、清单不被改写、零写入;随后持锁 recover 才重建', async () => {
    const { w, a } = await auditedWork('in-outcomes-');
    await put(w, 'state.json', STATE_OK);
    await put(w, MONTH, `${signalLine(sig('1'))}\n`);
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('absent');
    await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('consistent');
    // 崩溃遗留:新数据 + 临时清单;inspect 不删它、不写清单
    await put(w, MONTH, `${signalLine(sig('1'))}\n${signalLine(sig('2'))}\n`);
    await writeFile(w.io, `${snapFile(w)}.tmp`, 'crash leftover', { mode: 0o600 });
    const before = await tree(w.state);
    const snapBefore = await readText(snapFile(w));
    a.reset();
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('needs_rebuild');
    expect(a.calls).toEqual([]); // 零写入(变异:inspect 里删临时清单 / 重建清单 → 红)
    expect(await tree(w.state)).toEqual(before);
    expect(await readText(snapFile(w))).toBe(snapBefore);
    expect(await readText(`${snapFile(w)}.tmp`)).toBe('crash leftover');
    // 对照:recover 会写(删临时清单、重建清单)
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l, productionSnapshotValidator))).toBe(
      'rebuilt',
    );
    expect(await exists(`${snapFile(w)}.tmp`)).toBe(false);
    expect(await inspectSnapshot(w.io, productionSnapshotValidator)).toBe('consistent');
  });

  it('损坏 / 不安全与 recover 同一判定:同样抛原因码,且仍零写入、零改动', async () => {
    const { w, a } = await auditedWork('in-corrupt-');
    await put(w, 'state.json', STATE_OK);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await put(w, MONTH, 'garbage\n');
    a.reset();
    await expect(inspectSnapshot(w.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'signal_store_corrupt',
    });
    // 清单损坏 → snapshot_invalid;rsi/ 权限过宽 → state_dir_unsafe(不收紧)
    await remove(w.io, path.join(w.state, MONTH));
    await put(w, 'snapshot.json', 'x');
    await expect(inspectSnapshot(w.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'snapshot_invalid',
    });
    await chmod(w.io, path.join(w.state, 'rsi'), 0o750);
    a.reset();
    await expect(inspectSnapshot(w.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'state_dir_unsafe',
    });
    expect((await lstat(path.join(w.state, 'rsi'))).mode & 0o777).toBe(0o750);
    expect(a.calls).toEqual([]);
  });

  it('rsi/ 不存在但月文件已在 .state/ 下:inspect 仍校验它们(不因 rsi/ 缺失就当空)', async () => {
    const w = await newWork('in-nors-');
    await put(w, MONTH, 'garbage\n');
    expect(await exists(path.join(w.state, 'rsi'))).toBe(false);
    await expect(inspectSnapshot(w.io, productionSnapshotValidator)).rejects.toMatchObject({
      reason: 'signal_store_corrupt',
    });
    expect(await exists(path.join(w.state, 'rsi'))).toBe(false);
  });
});

describe('大库持锁时延(不引入摘要缓存;流式只降内存不降 I/O)', () => {
  it('24MiB 单月文件:commit + 校验 recover 在持锁内完成,并记录耗时(上限 90 秒,只防退化成不可用)', async () => {
    const w = await newWork('big-');
    const line = `${signalLine(sig('1', 'x'.repeat(200)))}\n`;
    const n = Math.ceil((24 * 1024 * 1024) / line.length);
    await mkdirp(w.io, path.join(w.state, 'signals/claude'), 0o700);
    await writeFile(w.io, path.join(w.state, MONTH), line.repeat(n), { mode: 0o600 });
    await put(w, 'state.json', STATE_OK);
    const t0 = Date.now();
    await withLock(w, async (l) => {
      expect(await recoverSnapshot(w.io, l, productionSnapshotValidator)).toBe('absent');
      await commitSnapshot(w.io, l);
      expect(await recoverSnapshot(w.io, l, productionSnapshotValidator)).toBe('consistent');
    });
    const ms = Date.now() - t0;
    process.stderr.write(`[big-lib] ${n} lines / 24MiB: ${ms}ms under lock\n`);
    expect(ms).toBeLessThan(90_000);
    const snap = await readSnapshot(w.io);
    expect(snap.kind === 'ok' && snap.snapshot.files.find((f) => f.name === MONTH)?.bytes).toBe(
      line.length * n,
    );
  }, 120_000);
});

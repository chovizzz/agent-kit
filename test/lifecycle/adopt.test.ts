/** adopt.ts 单元:信号事实装载(C2 / C4 的本机事实来源)的边界。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../src/contracts/signal.js';
import { sig } from '../fixtures/reflect/world.js';
import { loadSignalFacts } from '../../src/lifecycle/adopt.js';
import * as safe from '../../src/io/safe-fs.js';
import { SignalStoreError } from '../../src/signals/state-store.js';
import { createIoContext } from '../../src/io/paths.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';

async function world(rows: Record<string, string>) {
  const { dir } = await makeTempDir('adopt-');
  const io = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: '/usr/bin:/bin' },
  });
  for (const [rel, text] of Object.entries(rows)) {
    await safe.mkdirp(io, path.dirname(path.join(io.stateDir, rel)));
    await safe.writeFile(io, path.join(io.stateDir, rel), text);
  }
  return io;
}

const ID = sig({ project: 'A', session: 'S', index: 0, text: 'x' }).sig_id;
const OTHER = sig({ project: 'A', session: 'S', index: 1, text: 'x' }).sig_id;
const row = (o: Partial<Signal> = {}): string =>
  `${JSON.stringify({ ...sig({ project: 'A', session: 'S', index: 0, text: 'x' }), ...o })}\n`;

describe('loadSignalFacts', () => {
  it('只收需要的 sig;查不到返回 undefined(不抛)', async () => {
    const io = await world({
      'signals/claude/202610.jsonl': row({}) + row({ sig_id: OTHER }),
    });
    const f = await loadSignalFacts(io, new Set([ID, 'sig_missing000000000']));
    expect(f.lookup(ID)).toMatchObject({
      project_key: sig({ project: 'A', session: 'S', index: 0 }).project_key,
      session_ref: sig({ project: 'A', session: 'S', index: 0 }).session_ref,
    });
    expect(f.lookup('sig_missing000000000')).toBeUndefined();
    expect(f.sessionRefOf(ID)).toBe(sig({ project: 'A', session: 'S', index: 0 }).session_ref);
    expect(f.lookup(OTHER)).toBeUndefined(); // 不需要的不收
  });

  it('同一 sig 内容完全相同的重复行(跨月文件)可以;内容不同 → 查询时抛错', async () => {
    const same = await world({
      'signals/claude/202609.jsonl': row({}),
      'signals/claude/202610.jsonl': row({}),
    });
    expect((await loadSignalFacts(same, new Set([ID]))).lookup(ID)).toBeDefined();
    const diff = await world({
      'signals/claude/202609.jsonl': row({}),
      'signals/claude/202610.jsonl': row({ excerpt_redacted: 'y' }),
    });
    const f = await loadSignalFacts(diff, new Set([ID]));
    expect(() => f.lookup(ID)).toThrow(SignalStoreError);
  });

  it('缺字段的行 → 视为冲突(抛错,不当作查不到);非 JSON 行 → SignalStoreError', async () => {
    const bad = await world({
      'signals/claude/202610.jsonl': `${JSON.stringify({ sig_id: ID })}\n`,
    });
    const f = await loadSignalFacts(bad, new Set([ID]));
    expect(() => f.lookup(ID)).toThrow(SignalStoreError);
    const junk = await world({ 'signals/claude/202610.jsonl': '{nope\n' });
    await expect(loadSignalFacts(junk, new Set([ID]))).rejects.toThrow(SignalStoreError);
  });

  it('没有信号库目录 → 全部查不到', async () => {
    const io = await world({});
    const f = await loadSignalFacts(io, new Set([ID]));
    expect(f.lookup(ID)).toBeUndefined();
  });

  it('信号库根目录 / agent 目录 / 月份文件是符号链接 → SignalStoreError(不当作「查不到」)', async () => {
    const real = await world({ 'real/claude/202610.jsonl': row() });
    const dir = path.join(real.stateDir, 'real');
    await safe.symlink(real, dir, path.join(real.stateDir, 'signals'));
    await expect(loadSignalFacts(real, new Set([ID]))).rejects.toThrow(SignalStoreError);

    const agentLink = await world({ 'elsewhere/202610.jsonl': row() });
    await safe.mkdirp(agentLink, path.join(agentLink.stateDir, 'signals'));
    await safe.symlink(
      agentLink,
      path.join(agentLink.stateDir, 'elsewhere'),
      path.join(agentLink.stateDir, 'signals', 'claude'),
    );
    await expect(loadSignalFacts(agentLink, new Set([ID]))).rejects.toThrow(SignalStoreError);

    const fileLink = await world({ 'elsewhere.jsonl': row(), 'signals/claude/.keep': '' });
    await safe.symlink(
      fileLink,
      path.join(fileLink.stateDir, 'elsewhere.jsonl'),
      path.join(fileLink.stateDir, 'signals', 'claude', '202610.jsonl'),
    );
    await expect(loadSignalFacts(fileLink, new Set([ID]))).rejects.toThrow(SignalStoreError);
  });
});

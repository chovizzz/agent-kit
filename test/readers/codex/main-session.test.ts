/**
 * isMainSessionFile 与 spec §2.2.1 的 jq 判据逐项对齐,以及 discover 对单个文件首行读失败的容错。
 * jq 实测值(jq 1.7.1,`head -1 FILE | jq -e '((.payload.source | objects | has("subagent")) // false) | not'`):
 *   首行 [] / [1,2] / 5 / "x" / true、payload 为 [] / "s" / 5 → 退出码 5(报错;`// false` 压不住)→ 不是会话
 *   payload 缺失或 null、source 为 5 / [1] / 其它对象 → 退出码 0 → 主会话
 *   source 含 subagent 键 → 退出码 1 → 侧链
 * 评审(P0 readers L1)曾断言「payload 为数组时 jq 视为主会话」;在 javis 的 jq 1.7.1 上实测为 5,故 reader 现行行为正确。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from '../../../src/io/safe-fs.js';
import { isMainSessionFile } from '../../../src/readers/codex/reader.js';
import { setOpenObserver } from '../../../src/signals/open-readonly.js';
import { newWork } from '../../signals/helpers.js';
import { LineBuilder, writeRollout } from './build.js';
import { reader } from './helpers.js';

async function firstLine(prefix: string, line: string): Promise<string> {
  const w = await newWork(prefix);
  const f = path.join(w.dir, 'rollout-x.jsonl');
  await writeFile(w.io, f, `${line}\n{"type":"x"}\n`);
  return f;
}

describe('isMainSessionFile:与 jq 判据一致', () => {
  it.each([
    ['[]', false],
    ['[1,2]', false],
    ['5', false],
    ['"x"', false],
    ['true', false],
    ['{"payload":[]}', false],
    ['{"payload":"s"}', false],
    ['{"payload":5}', false],
    ['{bad', false],
    ['null', true],
    ['{}', true],
    ['{"payload":null}', true],
    ['{"payload":{}}', true],
    ['{"payload":{"source":5}}', true],
    ['{"payload":{"source":[1]}}', true],
    ['{"payload":{"source":"exec"}}', true],
    ['{"payload":{"source":{"other":1}}}', true],
    ['{"payload":{"source":{"subagent":1}}}', false],
    ['{"payload":{"source":{"subagent":null}}}', false],
  ])('首行 %s → %s', async (line, expected) => {
    expect(await isMainSessionFile(await firstLine('codex-main-', line))).toBe(expected);
  });
});

describe('discover:单个 rollout 首行读失败不炸掉整个 discover', () => {
  afterEach(() => {
    setOpenObserver(undefined);
  });

  it('坏文件被保留(留给读取阶段计 read_error),其它文件照常;stat 失败同样不抛', async () => {
    const w = await newWork('codex-discover-');
    const good = await writeRollout(w.io, w.sessions, new LineBuilder().meta().userItem('hi'), {
      id: 'good',
    });
    const bad = await writeRollout(w.io, w.sessions, new LineBuilder().meta().userItem('hi'), {
      id: 'bad',
      baseMs: Date.UTC(2026, 0, 2),
    });
    // 正向对照:没有注入故障时两个都是主会话
    const names = (refs: { path: string }[]): string[] => refs.map((r) => path.basename(r.path));
    const both = [path.basename(good), path.basename(bad)].sort();
    expect(names(await reader.discover(w.sessions)).sort()).toEqual(both);

    // 注入:对坏文件的「读行」与「stat」都抛 EACCES(模拟权限被掐 / 枚举后被删)
    setOpenObserver((e) => {
      if (path.basename(e.path) === path.basename(bad))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const refs = await reader.discover(w.sessions);
    expect(names(refs).sort()).toEqual(both);
    const badRef = refs.find((r) => path.basename(r.path) === path.basename(bad));
    const goodRef = refs.find((r) => path.basename(r.path) === path.basename(good));
    expect(badRef?.bytes).toBe(0);
    expect(goodRef?.bytes ?? 0).toBeGreaterThan(0);
    // 读取阶段会失败(由管线归为 read_error),而不是静默当成「不是会话」
    await expect(
      (async () => {
        const r = reader.read(badRef as NonNullable<typeof badRef>, { salt: 'e'.repeat(64) });
        for await (const _e of r.events) void _e;
      })(),
    ).rejects.toThrow(/EACCES/);
  });
});

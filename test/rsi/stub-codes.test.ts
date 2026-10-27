/**
 * R20-A2 B5-0:桩码 `RSI_NOT_IMPLEMENTED` 的出现位置登记(契约 §20.14 B3a-5 的例外清单,按块落成可执行的断言)。
 *
 * `src/rsi/**` 与 `src/commands/rsi.ts` 里每一处 `rsiStubExit(ctx, '<桩名>')` 的字面量调用都必须登记在 {@link REGISTERED},
 * **多一处或少一处都红**:B5 各块实装命令时必须同一次提交里删掉对应登记(少登记 = 偷偷留了桩;多登记 = 桩已删但没清登记)。
 * 这样 B5-0 先登记、各块陆续删,最后全部块合并后只剩 P1 预留与 A3 的 poke / hint。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

/** 文件(相对仓库根)→ 该文件里登记的桩名(升序);注释写明谁负责删 */
const REGISTERED: Readonly<Record<string, readonly string[]>> = {
  // B5a 已实装并删除登记:tick / status --ack / projects --rebuild-index(干跑与 --write)
  // B5b:confirm 实装
  'src/rsi/confirm.ts': ['confirm'],
  // B5c 已实装并删除登记:purge
  // A3:poke / hint(钩子专用入口,不属于 B5)
  'src/rsi/poke.ts': ['poke'],
  'src/rsi/hint.ts': ['hint'],
};
/** 分发器里 P1 预留子命令用变量调用桩(不是字面量),不进上表;这里钉住它仍存在 */
const DISPATCHER = 'src/commands/rsi.ts';

const CALL = /rsiStubExit\(\s*ctx\s*,\s*'([^']+)'\s*\)/g;

async function scan(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const dir = path.join(REPO_ROOT, 'src/rsi');
  const files = (await readDir(dir)).filter((e) => e.isFile && e.name.endsWith('.ts'));
  expect(files.length, '扫描到 src/rsi 下的文件(正向前提)').toBeGreaterThan(10);
  for (const e of files) {
    const rel = `src/rsi/${e.name}`;
    const text = await readText(path.join(REPO_ROOT, rel));
    const names = [...text.matchAll(CALL)].map((m) => m[1] as string).sort();
    if (names.length > 0) out[rel] = names;
  }
  return out;
}

describe('桩码出现位置登记(B5 各块实装时同步删除)', () => {
  it('src/rsi 下的字面量桩调用与登记表恰好相等', async () => {
    const found = await scan();
    expect(Object.keys(REGISTERED).length).toBeGreaterThan(0);
    expect(found).toEqual(
      Object.fromEntries(Object.entries(REGISTERED).map(([f, n]) => [f, [...n]])),
    );
  });

  it('分发器仍用变量调用桩(P1 预留子命令),且没有字面量桩调用', async () => {
    const text = await readText(path.join(REPO_ROOT, DISPATCHER));
    expect(text).toContain('rsiStubExit(ctx, reserved)');
    expect([...text.matchAll(CALL)]).toEqual([]);
  });

  it('反向对照:扫描正则能抓到一处新增的桩调用', () => {
    const sample = "x = rsiStubExit(ctx, 'tick'); y = rsiStubExit(ctx, 'purge');";
    expect([...sample.matchAll(CALL)].map((m) => m[1])).toEqual(['tick', 'purge']);
  });
});

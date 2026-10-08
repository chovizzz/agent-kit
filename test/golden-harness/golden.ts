/**
 * golden 快照框架(供 B07/B08 的 test/golden/** 引用)。
 *
 * - golden 目录镜像 `<agent>/<target>/<relPath>` 的文件树;比对按字节全等。
 * - 缺 golden、多出陈旧 golden、内容变了而 golden 没更新,都是失败(不会自动创建)。
 * - 只有显式更新才写:调用方传 `update: true`,或 `vitest run test/golden -u`(默认值取自 vitest 的 -u)。
 *   更新命令(待主代理加进 package.json):`"golden:update": "vitest run test/golden -u"`。
 * - 写 golden 目录需要它是写入根;契约的写入根固定为 out/、.state/、$KIT_TMP,所以更新模式下
 *   harness 自建 ctx,把 KIT_TMP 注入为 goldenDir(不读 process.env)。
 */
import * as path from 'node:path';
import { expect } from 'vitest';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { exists, readDir } from '../../src/io/read-fs.js';
import type { OutFile, RenderOutput } from '../../src/contracts/render.js';
import { reportToJson } from '../../src/render/report.js';
import { byteCompare, listTree, outFilesToTree, readTree } from '../../src/render/out-layout.js';

export interface GoldenDiff {
  /** 实际有、golden 没有 */
  missing: string[];
  /** golden 有、实际没有 */
  stale: string[];
  /** 两边都有但字节不同 */
  changed: string[];
}

export class GoldenMismatchError extends Error {
  constructor(
    message: string,
    readonly diff: GoldenDiff,
  ) {
    super(message);
    this.name = 'GoldenMismatchError';
  }
}

export class DeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeterminismError';
  }
}

/** vitest 是否带了 -u。读不到时按 false(不更新)。 */
export function isGoldenUpdateRequested(): boolean {
  const st = expect.getState() as unknown as { snapshotState?: { _updateSnapshot?: string } };
  return st.snapshotState?._updateSnapshot === 'all';
}

export function isEmptyDiff(d: GoldenDiff): boolean {
  return d.missing.length === 0 && d.stale.length === 0 && d.changed.length === 0;
}

export async function diffGolden(
  goldenDir: string,
  actual: ReadonlyMap<string, string>,
): Promise<GoldenDiff> {
  const golden = await readTree(goldenDir);
  const diff: GoldenDiff = { missing: [], stale: [], changed: [] };
  for (const [k, v] of actual) {
    const g = golden.get(k);
    if (g === undefined) diff.missing.push(k);
    else if (!Buffer.from(g, 'utf8').equals(Buffer.from(v, 'utf8'))) diff.changed.push(k);
  }
  for (const k of golden.keys()) if (!actual.has(k)) diff.stale.push(k);
  diff.missing.sort(byteCompare);
  diff.stale.sort(byteCompare);
  diff.changed.sort(byteCompare);
  return diff;
}

export function goldenWriteCtx(goldenDir: string): IoContext {
  return createIoContext({
    root: path.dirname(goldenDir),
    cwd: path.dirname(goldenDir),
    env: { KIT_TMP: goldenDir, KIT_WRITE_ROOTS: goldenDir, PATH: '/usr/bin:/bin' },
  });
}

async function pruneEmptyDirs(ctx: IoContext, goldenDir: string, from: string): Promise<void> {
  let dir = path.dirname(from);
  while (dir !== goldenDir && dir.startsWith(goldenDir + path.sep)) {
    if (!(await exists(dir)) || (await readDir(dir)).length > 0) return;
    await safe.remove(ctx, dir);
    dir = path.dirname(dir);
  }
}

export interface AssertGoldenOptions {
  goldenDir: string;
  actual: ReadonlyMap<string, string>;
  /** 缺省取 isGoldenUpdateRequested() */
  update?: boolean;
}

/** 比对;有差异且非更新模式 ⇒ 抛 GoldenMismatchError。更新模式写入/删除后返回 updated:true。 */
export async function assertGolden(opts: AssertGoldenOptions): Promise<{ updated: boolean }> {
  const update = opts.update ?? isGoldenUpdateRequested();
  const diff = await diffGolden(opts.goldenDir, opts.actual);
  if (isEmptyDiff(diff)) return { updated: false };
  if (!update) {
    throw new GoldenMismatchError(
      [
        'golden 与实际输出不一致(显式更新:vitest run test/golden -u)',
        ...diff.missing.map((k) => `  缺 golden: ${k}`),
        ...diff.changed.map((k) => `  内容变了: ${k}`),
        ...diff.stale.map((k) => `  陈旧 golden: ${k}`),
      ].join('\n'),
      diff,
    );
  }
  const ctx = goldenWriteCtx(opts.goldenDir);
  for (const k of [...diff.missing, ...diff.changed]) {
    const abs = path.join(opts.goldenDir, ...k.split('/'));
    await safe.mkdirp(ctx, path.dirname(abs));
    await safe.writeFile(ctx, abs, opts.actual.get(k) as string);
  }
  for (const k of diff.stale) {
    const abs = path.join(opts.goldenDir, ...k.split('/'));
    await safe.remove(ctx, abs);
    await pruneEmptyDirs(ctx, opts.goldenDir, abs);
  }
  return { updated: true };
}

/** 渲染输出 ⇒ golden 用的树(含 report.json,让报告也被锁住)。 */
export function renderOutputToTree(out: RenderOutput): Map<string, string> {
  const tree = outFilesToTree(out.files as OutFile[]);
  tree.set('_report.json', reportToJson(out.report));
  return new Map([...tree].sort((a, b) => byteCompare(a[0], b[0])));
}

/**
 * 确定性断言:同一输入深拷贝后跑 runs 次,序列化结果必须逐字节一致。
 * 不一致时抛 DeterminismError,指出第几次、首个差异位置。
 */
export function assertDeterministic<I>(
  render: (input: I) => RenderOutput,
  input: I,
  runs = 2,
): string {
  if (runs < 2) throw new Error('runs 必须 ≥ 2');
  let first: string | undefined;
  for (let i = 0; i < runs; i += 1) {
    const s = JSON.stringify(render(structuredClone(input)));
    if (first === undefined) first = s;
    else if (s !== first) {
      let at = 0;
      while (at < s.length && s[at] === first[at]) at += 1;
      throw new DeterminismError(`第 ${i + 1} 次渲染与第 1 次不同,首个差异在字符 ${at}`);
    }
  }
  return first as string;
}

export { listTree };

/**
 * R20-A2 B2:`recoverSnapshot` / `inspectSnapshot` 的校验器必填、生产代码不得带缺省结构校验器(contracts §20.5 R20-5.6 订正)。
 * 静态核对 src/:没有任何生产文件引用 `structuralValidator`;凡调用 recoverSnapshot / inspectSnapshot 的生产文件(定义它们的 snapshot.ts 除外)
 * 必须引用 `productionSnapshotValidator`。B2 之前没有生产调用方,所以另有正向对照证明扫描本身有效。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(p)));
    else if (e.isFile && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('生产代码没有缺省校验器', () => {
  it('src/ 下没有任何文件引用 structuralValidator(它只留在 test/rsi/structural-validator.ts)', async () => {
    const files = await walk(path.join(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50); // 正向对照:扫描确实读到了源码
    const hits: string[] = [];
    for (const f of files) {
      if ((await readText(f)).includes('structuralValidator'))
        hits.push(path.relative(REPO_ROOT, f));
    }
    expect(hits).toEqual([]);
  });

  it('调用 recoverSnapshot / inspectSnapshot 的生产文件(snapshot.ts 自身除外)都引用 productionSnapshotValidator', async () => {
    const files = await walk(path.join(REPO_ROOT, 'src'));
    const callers: string[] = [];
    for (const f of files) {
      if (f.endsWith(path.join('rsi', 'snapshot.ts'))) continue;
      const text = await readText(f);
      if (/\b(recoverSnapshot|inspectSnapshot)\s*\(/.test(text)) {
        callers.push(path.relative(REPO_ROOT, f));
        expect(text, f).toContain('productionSnapshotValidator');
      }
    }
    // 正向对照:定义文件与生产校验器文件确实存在且被扫到
    const snap = await readText(path.join(REPO_ROOT, 'src/rsi/snapshot.ts'));
    expect(snap).toMatch(/export async function recoverSnapshot\(/);
    expect(snap).not.toMatch(/validate: SnapshotValidator =/); // 参数必填:没有缺省值
    expect(snap).not.toMatch(/validate\?:/);
    expect(await readText(path.join(REPO_ROOT, 'src/rsi/validators.ts'))).toContain(
      'export const productionSnapshotValidator',
    );
    void callers; // B2 还没有生产调用方;B3 起接线后这里的循环才有实际断言
  });
});

describe('state.json 的 confirm 只有一个解析入口', () => {
  it('RsiConfirmSchema 只在 contracts/rsi.ts 与 rsi/state.ts 引用(别处宽松读 confirm.* 会绕过「坏 confirm = 失效」的统一判定)', async () => {
    const files = await walk(path.join(REPO_ROOT, 'src'));
    const hits: string[] = [];
    for (const f of files) {
      if ((await readText(f)).includes('RsiConfirmSchema')) hits.push(path.relative(REPO_ROOT, f));
    }
    expect(hits.sort()).toEqual(['src/contracts/rsi.ts', 'src/rsi/state.ts']);
  });
});

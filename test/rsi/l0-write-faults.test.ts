/**
 * R20-A2 B4c2:失锁故障注入(B3b-4 / D16)。每个写点之前都复核锁:在第 k 个写点之前换掉锁的 nonce(k 遍历全部写点),
 * 报 lock_lost,**之后零写入**(写审计计数,不只看最终目录)。两个场景(首次 / 增量)各遍历一遍;每类写点都有正向前提(写点列表里确实出现过),
 * 防止接线漏传 beforeWrite 时 k 遍历空转。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loseLock,
  recordOps,
  runL0,
  scenario,
  inputOf,
  type ScenarioKind,
} from './l0-run-fixture.js';

const SEP = path.sep;
const sess = (p: string): boolean => p.includes(`${SEP}sessions${SEP}`);
const sigs = (p: string): boolean => p.includes(`${SEP}signals${SEP}`);

describe.each(['first', 'incremental'] as const)('失锁:场景 %s', (kind: ScenarioKind) => {
  it('写点清单:每一类写点都出现(正向前提),然后第 k 个写点之前失锁 → lock_lost、之后零写入(k 遍历)', async () => {
    const { ops } = await recordOps(kind, `l0wf-rec-${kind}-`, { salt: kind === 'incremental' });
    const names = ops.map((o) => o.op);
    const has = (op: string, pred: (p: string) => boolean = () => true): boolean =>
      ops.some((o) => o.op === op && pred(o.path));
    // 信号库与会话计数库:四类目录 / 权限 / 临时文件 / rename 写点
    for (const [label, pred] of [
      ['signals', sigs],
      ['sessions', sess],
    ] as const) {
      for (const op of ['mkdirp', 'chmod', 'write-tmp', 'chmod-tmp', 'rename', 'chmod-final']) {
        if (kind === 'incremental' && op === 'mkdirp' && label === 'signals') continue; // 目录已在:writeSignals 仍调 mkdirp
        expect(has(op, pred), `${label}:${op}`).toBe(true);
      }
    }
    for (const n of ['projects.json', 'counts.json', 'state.json', 'cursor.json']) {
      for (const p of ['tmp-remove', 'tmp-write', 'rename'])
        expect(names, `${p}:${n}`).toContain(`${p}:${n}`);
    }
    expect(names).toContain('log-append');
    expect(names).toContain('snapshot-rename');
    if (kind === 'first') {
      expect(names).toContain('salt-create'); // 盐首建
      expect(names.indexOf('salt-create')).toBeLessThan(names.findIndex((n) => n === 'write-tmp'));
    } else {
      // 增量:既有月文件被去重(无新增)时的 chmod,以及已有月文件的重写
      expect(has('chmod-existing', sigs)).toBe(true);
      expect(has('chmod-existing', sess)).toBe(true);
    }
    // 两个月文件各自的 rename 写点(第二个月文件重写前后各是一个崩溃 / 失锁边界)
    const monthRenames = ops
      .filter((o) => o.op === 'rename' && sigs(o.path))
      .map((o) => path.basename(o.path));
    expect(new Set(monthRenames).size).toBeGreaterThanOrEqual(2);

    const N = ops.length;
    expect(N).toBeGreaterThan(20);
    for (let k = 1; k <= N; k++) {
      const fx = await scenario(kind, `l0wf-${kind}-${k}-`, { salt: kind === 'incremental' });
      let seen = 0;
      let atHook = -1;
      const base = fx.s.audit.length;
      await expect(
        runL0(fx, inputOf(), {
          beforeWrite: async () => {
            if (++seen !== k) return;
            atHook = fx.s.audit.length;
            await loseLock(fx.s);
          },
        }),
        `k=${k} ${ops[k - 1]?.op}`,
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(seen, `k=${k} 钩子确实触发过`).toBe(k);
      expect(atHook - base, `k=${k} 与记录的写点流一致`).toBe(ops[k - 1]?.audit);
      expect(fx.s.audit.length - atHook, `k=${k} ${ops[k - 1]?.op}:失锁之后零写入`).toBe(0);
    }
  }, 180_000);
});

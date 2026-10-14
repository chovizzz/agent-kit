/**
 * S5:D05 / D06 与 S3 计划器分类一致。同一份假 HOME 夹具,一边跑 doctor,一边对同一份磁盘快照跑
 * `planSync`(卸载模式,所有 agent:每个登记条目都会被分类一次),两边对每个条目的结论必须对得上。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_AGENT_IDS } from '../../src/contracts/common.js';
import type { SyncLedger } from '../../src/contracts/sync.js';
import { OWNED_DIRS } from '../../src/sync/classify.js';
import { planSync } from '../../src/sync/plan.js';
import { buildDiskSnapshot, readLedger } from '../../src/sync/snapshot.js';
import type { SyncPlan } from '../../src/sync/types.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  CODEX_MD,
  PI_MD,
  SKILL,
  checkOf,
  installed,
  runDoctor,
  type JsonReport,
  type World,
} from './world.js';

/** 计划器视角:某登记条目被分类成什么(与 D05 枚举对齐)。 */
function plannerState(plan: SyncPlan, p: string, blockId?: string): string {
  const hit = plan.ops.find(
    (o) => o.path === p && (blockId === undefined || o.blockId === blockId),
  );
  if (hit === undefined) return 'missing'; // drop:磁盘上已经没有了,计划不产生操作
  switch (hit.op) {
    case 'remove':
    case 'block_remove':
      return 'ok';
    case 'skip_drifted':
      return 'drifted';
    case 'refuse_link':
      return hit.code === 'SYNC_PATH_HARDLINK' ? 'hardlinked' : 'path_symlinked';
    case 'refuse_not_regular':
      return 'not_regular';
    case 'refuse_block_corrupt':
      return 'block_corrupt';
    default:
      return `other:${hit.op}`;
  }
}

async function plannerView(w: World): Promise<{ plan: SyncPlan; ledger: SyncLedger }> {
  const lr = await readLedger(w.home);
  if (lr.state !== 'ok') throw new Error('夹具应有登记表');
  const blockIds: Record<string, string[]> = {};
  for (const e of lr.ledger.entries) {
    if (e.block_id !== undefined) (blockIds[e.path] ??= []).push(e.block_id);
  }
  const snap = await buildDiskSnapshot({
    home: w.home,
    paths: lr.ledger.entries.map((e) => e.path),
    blockIds,
    ledgerPaths: lr.ledger.entries.map((e) => e.path),
    ownedDirs: OWNED_DIRS,
  });
  const plan = planSync({
    payload: null,
    payloadSha256: '0'.repeat(64),
    payloadSha: {},
    ledger: lr.ledger,
    disk: snap.snapshot,
    options: {
      agents: [...RENDER_AGENT_IDS],
      overwriteDrifted: false,
      uninstall: true,
      adopt: false,
      txnId: 'txn-00000000T000000Z-000000',
    },
  });
  return { plan, ledger: lr.ledger };
}

interface Scenario {
  name: string;
  /** 被改动的登记条目 */
  path: string;
  blockId?: string;
  d05: string;
  d06?: 'intact' | 'drifted' | 'corrupt' | 'missing';
  mutate(w: World): Promise<void>;
}

const BLOCK = 'agent-kit-rules';

const SCENARIOS: Scenario[] = [
  { name: '未改动', path: SKILL, d05: 'ok', mutate: async () => {} },
  {
    name: '独占文件被手改 → drifted',
    path: SKILL,
    d05: 'drifted',
    mutate: async (w) => w.put(SKILL, '用户改的\n'),
  },
  {
    name: '独占文件被删 → missing',
    path: SKILL,
    d05: 'missing',
    mutate: async (w) => safe.remove(w.io, path.join(w.home, SKILL)),
  },
  {
    name: '独占文件有第二个硬链接 → hardlinked',
    path: SKILL,
    d05: 'hardlinked',
    mutate: async (w) => safe.hardlink(w.io, path.join(w.home, SKILL), path.join(w.dir, 'copy')),
  },
  {
    name: '路径中间段是符号链接 → path_symlinked',
    path: SKILL,
    d05: 'path_symlinked',
    mutate: async (w) => {
      const target = path.join(w.dir, 'elsewhere');
      await safe.mkdirp(w.io, target);
      await safe.remove(w.io, path.join(w.home, '.claude/skills'));
      await safe.symlink(w.io, target, path.join(w.home, '.claude/skills'));
    },
  },
  {
    name: '独占文件被替换成目录 → not_regular',
    path: SKILL,
    d05: 'not_regular',
    mutate: async (w) => {
      await safe.remove(w.io, path.join(w.home, SKILL));
      await safe.mkdirp(w.io, path.join(w.home, SKILL));
    },
  },
  {
    name: '托管块 intact(块外有用户内容)',
    path: CODEX_MD,
    blockId: BLOCK,
    d05: 'ok',
    d06: 'intact',
    mutate: async (w) => w.put(CODEX_MD, `用户自己的\n\n${await w.read(CODEX_MD)}`),
  },
  {
    name: '托管块块体被手改、标记行没动 → drifted',
    path: PI_MD,
    blockId: BLOCK,
    d05: 'drifted',
    d06: 'drifted',
    mutate: async (w) => w.put(PI_MD, (await w.read(PI_MD)).replace('规则块', '改过的块')),
  },
  {
    name: '托管块被删(文件还在)→ missing',
    path: PI_MD,
    blockId: BLOCK,
    d05: 'missing',
    d06: 'missing',
    mutate: async (w) => w.put(PI_MD, '用户只剩自己的\n'),
  },
  {
    name: '托管块只剩 begin → block_corrupt',
    path: CODEX_MD,
    blockId: BLOCK,
    d05: 'block_corrupt',
    d06: 'corrupt',
    mutate: async (w) =>
      w.put(CODEX_MD, (await w.read(CODEX_MD)).replace('<!-- agent-kit:end -->\n', '')),
  },
];

describe('doctor D05 / D06 与 S3 计划器分类一致', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const w = await installed('consistency-');
      await sc.mutate(w);
      const { plan } = await plannerView(w);
      const expected = plannerState(plan, sc.path, sc.blockId);
      // 计划器与场景预期一致(场景表自身的对照)
      expect(expected, `计划器结论 ${sc.name}`).toBe(sc.d05);

      const { check } = await checkOf(w, 'D05');
      const itemPrefix = `${sc.d05}:~/${sc.path}${sc.blockId !== undefined ? `#${sc.blockId}` : ''}`;
      if (sc.d05 === 'ok') {
        expect(check.items.filter((i) => i.includes(`~/${sc.path}`))).toEqual([]);
      } else {
        expect(check.items, sc.name).toContain(itemPrefix);
      }
      // 计划整体可执行时(没有预检拒绝),doctor 的各状态计数 == 计划器对每个登记条目的分类计数;
      // 预检拒绝时计划器只报被拒条目(整次不写),只比对该条目
      const { ledger } = await plannerView(w);
      if (plan.status === 'ok') {
        const tally: Record<string, number> = {};
        for (const e of ledger.entries) {
          const st = plannerState(plan, e.path, e.block_id);
          tally[st] = (tally[st] ?? 0) + 1;
        }
        for (const [k, n] of Object.entries(tally)) {
          expect(check.counts[k] ?? 0, `${sc.name} ${k}`).toBe(n);
        }
      } else {
        expect(plan.status).toBe('refuse-all');
      }

      if (sc.d06 !== undefined) {
        const d6 = (await checkOf(w, 'D06')).check;
        expect(d6.counts[sc.d06], `${sc.name} D06`).toBeGreaterThanOrEqual(1);
        if (sc.d06 === 'drifted') expect(plannerState(plan, sc.path, sc.blockId)).toBe('drifted');
        if (sc.d06 === 'corrupt')
          expect(plannerState(plan, sc.path, sc.blockId)).toBe('block_corrupt');
      }
    });
  }

  it('全量 --json 里 D05 的状态计数之和 == 登记条目数', async () => {
    const w = await installed('consistency-sum-');
    const rep = JSON.parse((await runDoctor(w, ['--json', '--only', 'D05'])).out) as JsonReport;
    const { ledger } = await plannerView(w);
    const sum = Object.values(rep.checks[0]?.counts ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(ledger.entries.length);
    expect(ledger.entries.length).toBeGreaterThan(3);
  });
});

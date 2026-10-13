import { describe, expect, it } from 'vitest';
import {
  LESSON_PATTERNS,
  USER_CORRECTION_ENABLED,
  classifySignals,
  isExplicitLesson,
  lessonTier,
} from '../../src/reflect/classify.js';
import { buildClusters } from '../../src/reflect/cluster.js';
import { loadSignals } from '../../src/reflect/load.js';
import type { LoadedSignal } from '../../src/reflect/types.js';
import {
  L1,
  L2,
  L_SINGLE,
  putSignals,
  sig,
  testRedactor,
  worldSignals,
  newWork,
} from '../fixtures/reflect/world.js';

const asLoaded = (s: ReturnType<typeof sig>): LoadedSignal => s as LoadedSignal;

describe('reflect/classify', () => {
  it('显式教训句式:正例命中,反例(问句、否定、闲聊)不命中', () => {
    for (const t of [
      '以后提交前先跑 lint',
      '下次不要再改生成文件',
      '不要再直接 push 到主分支',
      'from now on run the linter first',
      'stop committing build output',
    ]) {
      expect(lessonTier(t), t).toBe('strong');
    }
    for (const t of ['务必先备份', '记住这个路径', 'remember to run tests', "don't use force"]) {
      expect(lessonTier(t), t).toBe('weak');
    }
    for (const t of [
      '以后要怎么处理这个?',
      '以后再说吧吗',
      '不用记住这个路径',
      '这个函数 always returns null',
      '今天天气不错',
      '',
    ]) {
      expect(isExplicitLesson(t), t).toBe(false);
    }
    expect(LESSON_PATTERNS.length).toBeGreaterThan(5);
  });

  it('user_correction 保持关闭:纠正式措辞不产生任何分类', () => {
    expect(USER_CORRECTION_ENABLED).toBe(false);
    const c = classifySignals([
      asLoaded(sig({ project: 'A', session: 'A1', index: 0, text: '不对,应该用 pnpm 而不是 npm' })),
    ]);
    expect(c.lessons).toEqual([]);
    expect(c.retryPairs).toEqual([]);
  });

  it('tool_fail_retry(真实形状:失败信号无 tool_name,工具取自前驱 tool_call)', () => {
    const pairs = (...xs: ReturnType<typeof sig>[]) => classifySignals(xs.map(asLoaded)).retryPairs;
    const call = (index: number, tool: string, extra: object = {}) =>
      sig({ project: 'A', session: 'A1', index, kind: 'tool_call', tool, text: 'cmd', ...extra });
    const fail = (index: number) =>
      sig({ project: 'A', session: 'A1', index, kind: 'tool_result_failed' });
    // 正向对照:前驱 → 失败 → 同名重试
    const ok = pairs(call(1, 'Bash'), fail(2), call(3, 'Bash'));
    expect(ok).toHaveLength(1);
    expect(ok[0]?.tool).toBe('Bash');
    expect(ok[0]?.failure.event_index).toBe(2);
    expect(ok[0]?.retry.event_index).toBe(3);
    // 乱序输入结果相同(按 event_index 排序)
    const shuffled = pairs(fail(2), call(3, 'Bash'), call(1, 'Bash'));
    expect(shuffled).toHaveLength(1);
    expect([shuffled[0]?.failure.event_index, shuffled[0]?.retry.event_index]).toEqual([2, 3]);
    // 前驱取"最近的"那条 tool_call:Read(1) Bash(2) 失败(3) → 工具是 Bash,Read 的重试不算
    const nearest = pairs(call(1, 'Read'), call(2, 'Bash'), fail(3), call(4, 'Read'));
    expect(nearest).toEqual([]);
    expect(pairs(call(1, 'Read'), call(2, 'Bash'), fail(3), call(4, 'Bash'))[0]?.tool).toBe('Bash');
    // 前驱缺失 → 不配对
    expect(pairs(fail(2), call(3, 'Bash'))).toEqual([]);
    // 前驱与失败之间隔着 user_message → 不配对
    const um = sig({ project: 'A', session: 'A1', index: 2, text: '好的' });
    expect(pairs(call(1, 'Bash'), um, fail(3), call(4, 'Bash'))).toEqual([]);
    // 重试被下一条用户消息截断 → 不配对
    const cut = sig({ project: 'A', session: 'A1', index: 3, text: '好的' });
    expect(pairs(call(1, 'Bash'), fail(2), cut, call(4, 'Bash'))).toEqual([]);
    // 其它工具 / 太远 → 不配对
    expect(pairs(call(1, 'Bash'), fail(2), call(3, 'Read'))).toEqual([]);
    expect(pairs(call(1, 'Bash'), fail(2), call(20, 'Bash'))).toEqual([]);
    // 前驱离失败太远(窗口外) → 不配对
    expect(pairs(call(1, 'Bash'), fail(30), call(31, 'Bash'))).toEqual([]);
    // 前驱没有 tool_name(外部内容会话不带) → 不配对
    const noName = sig({
      project: 'A',
      session: 'A1',
      index: 1,
      kind: 'tool_call',
      external: true,
    });
    expect(pairs(noName, fail(2), call(3, 'Bash'))).toEqual([]);
    // 会话里有外部内容信号 → 整个会话不配对
    const ext = sig({ project: 'A', session: 'A1', index: 9, kind: 'tool_call', external: true });
    expect(pairs(call(1, 'Bash'), fail(2), call(3, 'Bash'), ext)).toEqual([]);
  });

  it('失败信号带 tool_name 违反一致性(R1):装载时按 structure_unknown 排除并计数', async () => {
    const w = await newWork('rl-badtool-');
    await putSignals(w.io, [
      sig({ project: 'A', session: 'A1', index: 1, kind: 'tool_call', tool: 'Bash', text: 'cmd' }),
      sig({ project: 'A', session: 'A1', index: 2, kind: 'tool_result_failed', badTool: 'Bash' }),
      sig({ project: 'A', session: 'A1', index: 3, kind: 'tool_call', tool: 'Bash', text: 'cmd' }),
    ]);
    const r = await loadSignals(w.io, testRedactor());
    expect(r.stats.structure_unknown).toBe(1);
    expect(r.signals).toHaveLength(2); // 正向对照:另两条正常
    expect(classifySignals(r.signals).retryPairs).toEqual([]); // 没有失败信号 → 没有配对
  });
});

describe('reflect/cluster', () => {
  async function world() {
    const w = await newWork('rl-cl-');
    await putSignals(w.io, worldSignals());
    const { signals } = await loadSignals(w.io, testRedactor());
    return signals;
  }

  it('相近教训聚成一组,会话数/项目数由合并侧计算;单项目单会话的教训不可入团队层', async () => {
    const signals = await world();
    const clusters = buildClusters(classifySignals(signals));
    const lint = clusters.find((c) => c.members.some((m) => m.excerpt_redacted === L1));
    expect(lint).toBeDefined();
    expect(lint?.members.map((m) => m.excerpt_redacted).sort()).toEqual([L1, L2].sort());
    expect(lint?.sessions).toBe(2);
    expect(lint?.projects).toBe(2);
    expect(lint?.teamEligible).toBe(true);
    const single = clusters.find((c) => c.members.some((m) => m.excerpt_redacted === L_SINGLE));
    expect(single?.teamEligible).toBe(false);
    const retry = clusters.find((c) => c.kind === 'tool_fail_retry');
    expect(retry?.tool).toBe('Bash');
    expect(retry?.failures).toBe(2);
    expect(retry?.teamEligible).toBe(true);
    // 失败结果不是可作证据的成员(摘录已被清空),只有重试调用是
    expect(retry?.members.every((m) => m.event_kind === 'tool_call')).toBe(true);
  });

  it('确定性:输入顺序打乱,聚类结果(含编号)不变', async () => {
    const signals = await world();
    const a = buildClusters(classifySignals(signals));
    const b = buildClusters(classifySignals([...signals].reverse()));
    const shape = (cs: typeof a) =>
      JSON.stringify(
        cs.map((c) => [
          c.id,
          c.kind,
          c.members.map((m) => m.sig_id).sort(),
          c.sessions,
          c.projects,
        ]),
      );
    expect(shape(b)).toBe(shape(a));
  });

  it('只靠弱标记的单次教训不入选;tool_fail_retry 少于 2 个会话不入选', () => {
    const weak = classifySignals([
      asLoaded(sig({ project: 'A', session: 'A1', index: 0, text: '务必先备份数据库' })),
    ]);
    expect(weak.lessons).toHaveLength(1);
    expect(buildClusters(weak)).toEqual([]);
    const strong = classifySignals([
      asLoaded(sig({ project: 'A', session: 'A1', index: 0, text: '以后先备份数据库' })),
    ]);
    expect(buildClusters(strong)).toHaveLength(1);
    const f = sig({
      project: 'A',
      session: 'A1',
      index: 2,
      kind: 'tool_result_failed',
      tool: 'Bash',
    });
    const r = sig({
      project: 'A',
      session: 'A1',
      index: 3,
      kind: 'tool_call',
      tool: 'Bash',
      text: 'ls',
    });
    expect(buildClusters(classifySignals([f, r].map(asLoaded)))).toEqual([]);
  });
});

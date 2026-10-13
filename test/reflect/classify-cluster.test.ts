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

  it('tool_fail_retry:窗口内同名工具重试成对;被用户消息截断则不算;其它工具不算', () => {
    const base = (extra: ReturnType<typeof sig>[]) =>
      classifySignals(extra.map(asLoaded)).retryPairs.length;
    const f = sig({
      project: 'A',
      session: 'A1',
      index: 2,
      kind: 'tool_result_failed',
      tool: 'Bash',
    });
    const retry = sig({
      project: 'A',
      session: 'A1',
      index: 4,
      kind: 'tool_call',
      tool: 'Bash',
      text: 'ls',
    });
    expect(base([f, retry])).toBe(1);
    const cut = sig({ project: 'A', session: 'A1', index: 3, text: '好的' });
    expect(base([f, cut, retry])).toBe(0);
    const other = sig({
      project: 'A',
      session: 'A1',
      index: 4,
      kind: 'tool_call',
      tool: 'Read',
      text: 'x',
    });
    expect(base([f, other])).toBe(0);
    const far = sig({
      project: 'A',
      session: 'A1',
      index: 20,
      kind: 'tool_call',
      tool: 'Bash',
      text: 'x',
    });
    expect(base([f, far])).toBe(0);
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

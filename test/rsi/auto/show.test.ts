/**
 * `rsi show <id>`(W8a;contracts R21-12.8、R21-1.9、N4-2、§21.24 W0-22 第 5、10 条):TTY 与参数顺序、输出边界(清洗 / 泄漏闸 / 标签)、
 * 内容验证双读协议(推进 head、增删 journal、同名替换 journal、对象消失 → 重试 / busy;改后改回不被检出且文案不含「原子」)、journal 三态、关联提案裁决段降级。
 */
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_LABEL } from '../../../src/contracts/rsi.js';
import { journalNameOf } from '../../../src/rsi/auto/read/stall.js';
import { runShow } from '../../../src/rsi/auto/read/show.js';
import { rec } from '../personal/transition-fixture.js';
import {
  HEAD,
  ID,
  SHA,
  makeSink,
  makeWorld,
  portsOf,
  recordFile,
  setCommit,
  type World,
} from './auto-fixture.js';

const BODY_PATH = 'rules/ra_0123456789ab.md';

function worldWith(body = 'rule body line 1\nline 2\n', record = rec('canary')): World {
  const w = makeWorld();
  setCommit(w, HEAD, { ...recordFile(record), [BODY_PATH]: body });
  return w;
}

async function show(
  w: World,
  argv: string[] = [ID],
  o: { tty?: boolean; forbidden?: string[] } = {},
) {
  const sink = makeSink();
  const code = await runShow(portsOf(w), argv, {
    isTty: o.tty ?? true,
    sink,
    forbidden: o.forbidden ?? [],
  });
  return { code, ...sink.text() };
}

const txnText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema_version: 1,
    txn_id: journalNameOf(ID, SHA),
    candidate_id: ID,
    kind: 'rollback',
    reason: 'vetoed',
    target_terminal: 'rolled_back',
    phase: 'rollback_requested',
    identity12: null,
    at: '2026-11-12T00:00:00.000Z',
    content_sha256: SHA,
    by: 'veto',
    terminal_event: { kind: 'veto', evidence: 'x' },
    ...over,
  });

describe('参数与 TTY 顺序(都在读取之前判)', () => {
  it('无 TTY → 退 2 not_tty,且没有任何读取;未知参数 → unknown_arg;id 形状不对 / 不存在 → unknown_id(退 2)', async () => {
    const w = worldWith();
    const r = await show(w, [ID], { tty: false });
    expect([r.code, r.out, r.err]).toEqual([2, '', 'RSI_USAGE reason=not_tty\n']);
    expect(w.calls.head + w.calls.commit + w.calls.names).toBe(0);
    for (const argv of [[], [ID, ID], ['--json'], ['-x']]) {
      expect((await show(w, argv)).err, argv.join(' ')).toBe('RSI_USAGE reason=unknown_arg\n');
    }
    expect((await show(w, ['ra_xyz'])).err).toBe('RSI_USAGE reason=unknown_id\n');
    const r2 = await show(w, ['ra_ffffffffffff']);
    expect([r2.code, r2.out, r2.err]).toEqual([2, '', 'RSI_USAGE reason=unknown_id\n']);
  });

  it('私有仓库从未建过(head.json 不存在)→ 没有候选 → unknown_id(退 2);不是「读失败」', async () => {
    const r = await show(makeWorld());
    expect([r.code, r.err]).toEqual([2, 'RSI_USAGE reason=unknown_id\n']);
  });
});

describe('输出边界', () => {
  it('每处正文前带 RSI_AUTO_LABEL(只引用常量);正文逐行带「| 」前缀;一致性口径是 double-read,不写「原子」', async () => {
    const r = await show(worldWith());
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    const at = lines.indexOf(RSI_AUTO_LABEL);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe('正文 1/1');
    expect(lines.slice(at + 2, at + 4)).toEqual(['| rule body line 1', '| line 2']);
    expect(r.out).toContain('record=recorded head=0123456789ab consistency=double-read');
    expect(r.out).not.toContain('原子');
    expect(r.out).not.toContain('一致快照');
    expect(r.out).toContain(`id=${ID} lifecycle=canary`);
  });

  it('正文清洗:控制 / 双向覆盖 / 行分隔字符 → `?`;正文不能伪造本命令的行(只有一行真正的 journal=)', async () => {
    const w = worldWith(
      'a\u202Eb\u0007c\u2028d\njournal=ok\nid=ra_ffffffffffff lifecycle=adopted\n',
    );
    const r = await show(w);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(new RegExp('[\\u202E\\u0007\\u2028]'));
    expect(r.out).toContain('| a?b?c?d');
    expect(r.out.split('\n').filter((l) => l.startsWith('journal='))).toEqual(['journal=absent']);
    expect(r.out.split('\n').filter((l) => l.startsWith('id='))).toHaveLength(1);
  });

  it('泄漏闸:正文含禁止值 → 退 3 output_leak,stdout 一个字节都不写', async () => {
    const r = await show(worldWith('see /home/someone/secrets here'), [ID], {
      forbidden: ['/home/someone'],
    });
    expect([r.code, r.out, r.err]).toEqual([3, '', 'RSI_FAIL_CLOSED reason=output_leak\n']);
  });

  it('正文超过上限被截断并标注;记录提交里没有正文文件 → 标注缺失,不报错', async () => {
    const big = await show(worldWith('x'.repeat(70 * 1024)));
    expect(big.out).toContain('| (正文超过上限,已截断)');
    const w = makeWorld();
    setCommit(w, HEAD, recordFile(rec('canary')));
    const r = await show(w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('| (记录提交里没有该文件)');
  });
});

describe('journal 三态与保护标记', () => {
  it('absent(只表示「该次读取下不存在」)/ ok / invalid;invalid 只写「按运行手册处置」,不含路径与「删除即可」', async () => {
    const w = worldWith();
    expect((await show(w)).out).toContain('journal=absent');
    const name = journalNameOf(ID, SHA);
    w.names = [name];
    w.journals[name] = { kind: 'ok', text: txnText() };
    expect((await show(w)).out).toContain('journal=ok');
    for (const bad of [
      txnText({ txn_id: '0'.repeat(16) }),
      txnText({ content_sha256: 'b'.repeat(64) }),
      txnText({ by: 'clear' }),
      '{not json',
    ]) {
      w.journals[name] = { kind: 'ok', text: bad };
      const r = await show(w);
      expect(r.out, bad).toContain('journal=invalid');
      expect(r.out).toContain('按运行手册处置');
      expect(r.out).not.toContain('删除即可');
      expect(r.out).not.toContain(name);
    }
  });

  it('视图里该候选的保护标记出现在 show 输出里', async () => {
    const w = worldWith();
    w.view = {
      kind: 'ok',
      text: JSON.stringify({
        schema_version: 1,
        as_of: '2026-11-13T08:00:00.000Z',
        record_oid: HEAD,
        pipeline: { states: {}, last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },
        budget: { used_pct: 0 },
        cost: { injected_bytes_mean: 0, s2_count: 0 },
        canary: null,
        last_rollback: null,
        rolling_back: [],
        rolling_back_truncated: false,
        protection_marks: [{ id: ID, mark: 'protection_unknown', at: '2026-11-12T00:00:00.000Z' }],
        protection_marks_truncated: false,
      }),
    };
    expect((await show(w)).out).toContain(
      'protection_mark=protection_unknown at=2026-11-12T00:00:00.000Z',
    );
  });
});

describe('内容验证双读协议', () => {
  const headVariant = (n: number): string =>
    JSON.stringify({
      schema_version: 1,
      head: HEAD,
      owner_repo_fp: n.toString(16).padStart(16, '0'),
    });

  it('head.json 在两次读之间被改动一次 → 回到开头重试后成功;每次都被改 → 3 次用尽退 4 RSI_SNAPSHOT_BUSY', async () => {
    const once = worldWith();
    once.hooks.after = (op, n) => {
      if (op === 'head' && n === 1) once.head = { kind: 'ok', text: headVariant(1) };
    };
    expect((await show(once)).code).toBe(0);

    const always = worldWith();
    always.hooks.after = (op, n) => {
      if (op === 'head') always.head = { kind: 'ok', text: headVariant(n) };
    };
    const r = await show(always);
    expect([r.code, r.out, r.err]).toEqual([4, '', 'RSI_SNAPSHOT_BUSY\n']);
    expect(always.calls.head).toBe(6); // 3 次尝试 × 两遍
  });

  it('事务目录增删、撤销凭据变化 → 同样不稳定(用尽退 4)', async () => {
    const a = worldWith();
    a.hooks.after = (op, n) => {
      if (op === 'names') a.names = [`${n.toString(16).padStart(16, '0')}`];
    };
    expect((await show(a)).code).toBe(4);
    const b = worldWith();
    b.hooks.after = (op, n) => {
      if (op === 'rev') b.rev = { kind: 'ok', text: `r${n}` };
    };
    expect((await show(b)).code).toBe(4);
  });

  it('同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它', async () => {
    const w = worldWith();
    const name = journalNameOf(ID, SHA);
    w.names = [name];
    w.journals[name] = { kind: 'ok', text: txnText() };
    w.hooks.after = (op, n) => {
      if (op === 'journal') {
        w.journals[name] = {
          kind: 'ok',
          text: txnText({ phase: n % 2 === 0 ? 'rollback_requested' : 'injection_disabled' }),
        };
      }
    };
    const r = await show(w);
    expect([r.code, r.err]).toEqual([4, 'RSI_SNAPSHOT_BUSY\n']);
  });

  it('改后改回(ABA)不被检出:输出照常,文案不含「原子」', async () => {
    const w = worldWith();
    w.hooks.after = (op, n) => {
      if (op === 'rev' && n === 1) w.rev = { kind: 'ok', text: 'changed' };
      if (op === 'tree') w.rev = { kind: 'absent' };
    };
    const r = await show(w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('consistency=double-read');
    expect(r.out).not.toContain('原子');
  });

  it('记录提交对象消失(gc)→ 回到开头重试;持续消失 → 用尽退 4,不是「没有候选」', async () => {
    const w = worldWith();
    w.missingCommits.add(HEAD);
    const r = await show(w);
    expect([r.code, r.err]).toEqual([4, 'RSI_SNAPSHOT_BUSY\n']);
  });
});

describe('读取失败一律 fail-closed(退 3,不当成「没有候选」)', () => {
  it('适配器不可读 / 未装配 → 3 personal_repo_invalid;head.json 不合规 → 同;记录不合规 / 文件名与 id 不符 → 3 candidate_invalid', async () => {
    const a = worldWith();
    a.recordedUnreadable = 'not_wired';
    expect((await show(a)).err).toBe('RSI_FAIL_CLOSED reason=personal_repo_invalid\n');
    const b = worldWith();
    b.head = { kind: 'ok', text: 'not json' };
    expect((await show(b)).err).toBe('RSI_FAIL_CLOSED reason=personal_repo_invalid\n');
    const c = makeWorld();
    setCommit(c, HEAD, { 'lifecycle/ra_aaaaaaaaaaaa.json': JSON.stringify(rec('canary')) });
    expect((await show(c)).err).toBe('RSI_FAIL_CLOSED reason=candidate_invalid\n');
    const d = makeWorld();
    setCommit(d, HEAD, { [`lifecycle/${ID}.json`]: '{"id":1}' });
    expect((await show(d)).err).toBe('RSI_FAIL_CLOSED reason=candidate_invalid\n');
    const e = worldWith();
    e.head = { kind: 'unreadable' };
    const re = await show(e);
    expect([re.code, re.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n']);
  });
});

describe('N4-2 关联提案裁决段(失败只影响该段)', () => {
  const withSource = (): World =>
    worldWith(
      'body\n',
      rec('canary', { source_proposal: { run_id: 'run-20261109-01', proposal_id: 'p1' } }),
    );

  it('source_proposal 为 null → 没有该段', async () => {
    expect((await show(worldWith())).out).not.toContain('关联提案裁决');
  });

  it('有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared', async () => {
    const w = withSource();
    w.judge = {
      kind: 'ok',
      judge_provenance: 'self_report',
      verdict: 'accept',
      overfit: 'none',
      injection: 'none',
      declared: 'vendor\u0007x',
    };
    const r = await show(w);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      '关联提案裁决: judge_provenance=self_report verdict=accept overfit=none injection=none',
    );
    expect(r.out).toContain('declared=vendor?x');
    expect(r.out.split('\n').filter((l) => l === RSI_AUTO_LABEL).length).toBe(2);
  });

  it('裁决读取不可用 / 抛错 → 只有该段是 unavailable,其余输出与退出码不变', async () => {
    for (const j of [{ kind: 'unavailable' } as const, 'throw' as const]) {
      const w = withSource();
      w.judge = j;
      const r = await show(w);
      expect(r.code).toBe(0);
      expect(r.out).toContain('关联提案裁决: unavailable');
      expect(r.out).toContain('| body');
    }
    const w = withSource();
    w.judge = { kind: 'absent' };
    expect((await show(w)).out).toContain('关联提案裁决: none');
  });
});

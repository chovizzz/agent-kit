/**
 * W0-6 候选来源 / W0-2 签名 / 创建行(R21-4.1 `(无) → proposed`)。纯函数,无 I/O。
 */
import { describe, expect, it } from 'vitest';
import { PersonalLifecycleRecordSchema } from '../../../src/contracts/rsi-personal.js';
import {
  buildDraft,
  clusterIdOf,
  deriveClusterSignature,
  rewriteOrigin,
  selectable,
} from '../../../src/rsi/personal/candidate-source.js';
import {
  creationFiles,
  creationIdemKey,
  newRecord,
  newWorkingCopy,
} from '../../../src/rsi/personal/candidate-record.js';
import { candidateId } from '../../../src/rsi/personal/ids.js';
import { DEFAULT_SIGNALS, draftOf, fingerprint, staged, toolSignal } from './w3-fixture.js';

describe('W0-6 候选来源', () => {
  it('只有 layer=personal ∧ op=add ∧ 单目标的提案成为候选来源', () => {
    expect(selectable(staged().proposal)).toBe(true);
    expect(selectable(staged({ layer: 'team' }).proposal)).toBe(false);
    expect(selectable(staged({ op: 'edit' }).proposal)).toBe(false);
  });
  it('类别机械判:fact ∧ volatile ∧ trigger 非空 → pitfall,其余 → rule', () => {
    expect(draftOf().category).toBe('rule');
    expect(draftOf({ kind: 'fact', volatility: 'volatile', trigger: 'pnpm test' }).category).toBe(
      'pitfall',
    );
    expect(draftOf({ kind: 'fact', volatility: 'volatile' }).category).toBe('rule');
    expect(draftOf({ kind: 'fact', volatility: 'stable', trigger: 'x' }).category).toBe('rule');
  });
  it('候选 id = W1 的 candidateId(run, proposal, content_sha256);同输入同 id,内容变则 id 变', () => {
    const d = draftOf();
    expect(d.id).toBe(candidateId(d.runId, d.proposalId, d.contentSha256));
    expect(draftOf().id).toBe(d.id);
    expect(draftOf({ body: { why: '另一个理由说明' } }).id).not.toBe(d.id);
  });
  it('存放的原子文件 origin=auto_rsi,正文与 id 不变;路径按类别', () => {
    const d = draftOf();
    expect(d.atom.fm.origin).toBe('auto_rsi');
    expect(d.content).toContain('origin: auto_rsi');
    expect(d.targetPath).toBe(`rules/${d.id}.md`);
    expect(draftOf({ kind: 'fact', volatility: 'volatile', trigger: 't' }).targetPath).toMatch(
      /^pitfalls\/ra_/,
    );
  });
  it('跳过:规则文件无法装载 / 原子 id 与提案目标不一致 / 无法派生签名', () => {
    const s = staged();
    expect(buildDraft({ ...s, ruleText: 'not an atom' }, DEFAULT_SIGNALS, { fingerprint })).toEqual(
      {
        kind: 'skip',
        reason: 'rule_unloadable',
      },
    );
    const mismatch = { ...s, proposal: { ...s.proposal, targets: ['other-id'] } };
    expect(buildDraft(mismatch, DEFAULT_SIGNALS, { fingerprint })).toEqual({
      kind: 'skip',
      reason: 'id_mismatch',
    });
    expect(buildDraft(s, [], { fingerprint })).toEqual({
      kind: 'skip',
      reason: 'signature_unavailable',
    });
  });
  it('fingerprint 返回非 16 位十六进制 → 抛(不写半截记录)', () => {
    expect(() => buildDraft(staged(), DEFAULT_SIGNALS, { fingerprint: () => 'zz' })).toThrow();
  });
  it('rewriteOrigin:无 frontmatter → undefined;无 origin 行 → 补一行', () => {
    expect(rewriteOrigin('hello')).toBeUndefined();
    expect(rewriteOrigin('---\nid: x\n---\nbody')).toBe('---\nid: x\norigin: auto_rsi\n---\nbody');
  });
});

describe('W0-2 聚类签名', () => {
  it('全部是带工具名的失败信号 → tool 签名;错误类一致才加窄', () => {
    expect(deriveClusterSignature(DEFAULT_SIGNALS)).toEqual({
      kind: 'tool',
      tool_name: 'Bash',
      tool_error_class: 'not_found',
    });
    const mixed = [
      toolSignal(1, '2026-11-01', 1),
      toolSignal(2, '2026-11-02', 2, { tool_error_class: 'timeout' }),
    ];
    expect(deriveClusterSignature(mixed)).toEqual({ kind: 'tool', tool_name: 'Bash' });
  });
  it('否则 lesson 签名:token 升序去重、≤ 32;无证据 / 无 token → null', () => {
    const lesson = (n: number, text: string) =>
      toolSignal(n, '2026-11-0' + n, n, {
        type: 'explicit_lesson',
        event_kind: 'user_message',
        tool_name: undefined,
        excerpt_redacted: text,
      });
    const sig = deriveClusterSignature([
      lesson(1, 'always run frozen lockfile install'),
      lesson(2, 'run frozen lockfile install first'),
    ]);
    expect(sig?.kind).toBe('lesson');
    if (sig?.kind === 'lesson') {
      expect(sig.rep_tokens).toEqual([...sig.rep_tokens].sort());
      expect(sig.rep_tokens).toContain('lockfile');
      expect(sig.rep_tokens.length).toBeLessThanOrEqual(32);
    }
    expect(deriveClusterSignature([])).toBeNull();
  });
  it('cluster id 由签名派生:同签名同 id', () => {
    const a = { kind: 'tool', tool_name: 'Bash' } as const;
    expect(clusterIdOf(a)).toBe(clusterIdOf({ ...a }));
    expect(clusterIdOf(a)).not.toBe(clusterIdOf({ kind: 'tool', tool_name: 'Edit' }));
    expect(clusterIdOf(a)).toMatch(/^c_[0-9a-f]{8}$/);
  });
});

describe('创建行 (无) → proposed', () => {
  it('记录合法、proposed、全 none、一条 ingested 转移,签名与来源提案创建时写入', () => {
    const d = draftOf();
    const r = newRecord(d, '2026-11-10T12:00:00.000Z', true);
    expect(PersonalLifecycleRecordSchema.safeParse(r).success).toBe(true);
    expect(r.lifecycle).toBe('proposed');
    expect(r.deploy).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
    expect(r.transitions).toHaveLength(1);
    expect(r.transitions[0]).toMatchObject({
      from: 'none',
      to: 'proposed',
      reason: 'ingested',
      idem_key: creationIdemKey(d),
    });
    expect(r.overlaps_preset).toBe(true);
    expect(r.cluster_signature).toEqual(d.clusterSignature);
    expect(r.source_proposal).toEqual({ run_id: d.runId, proposal_id: d.proposalId });
    expect(r.fp_hmac).toBe(d.fpHmac);
  });
  it('idem_key 不含时钟:不同时间同一键', () => {
    const d = draftOf();
    expect(newRecord(d, '2026-11-10T00:00:00Z', false).transitions[0]?.idem_key).toBe(
      newRecord(d, '2026-12-31T00:00:00Z', false).transitions[0]?.idem_key,
    );
  });
  it('私有仓库文件:lifecycle/<id>.json + 原子文件(只有受管目录)', () => {
    const d = draftOf();
    const files = creationFiles(d, newRecord(d, '2026-11-10T12:00:00Z', false));
    expect(files.map((f) => f.path)).toEqual([`lifecycle/${d.id}.json`, d.targetPath]);
    expect(files[0]?.content.endsWith('\n')).toBe(true);
  });
  it('工作副本:shadow 计数清零、两个日期为空、证据归属去重升序', () => {
    const d = draftOf();
    const wc = newWorkingCopy(d, DEFAULT_SIGNALS);
    expect(wc.shadow).toEqual({
      sessions: 0,
      hits: 0,
      canary_ready_since: null,
      queued_since: null,
    });
    expect(wc.evidence.days).toEqual(['2026-11-01', '2026-11-02']);
    expect(wc.evidence.sessions.length).toBe(2);
  });
});

/** G3 真判据(lifecycleCriteria)测试用的合成世界。全部合成数据。 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { attestFileName } from '../../src/contracts/attest.js';
import { lifecycleFileName } from '../../src/contracts/lifecycle.js';
import { normalizedRuleSha256 } from '../../src/guards/criteria.js';
import { readTextSync } from '../../src/io/read-fs.js';
import { DEFAULT_BODY } from '../fixtures/guards/atoms.js';

export const ID = 'sample-atom';
export const PATH = 'rules/general/sample-atom.md';
export const PID = '2026-10-08-001';
export const PROPOSAL_PATH = `proposals/${PID}.yaml`;
export const OWNER = '@owner-handle';

export const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface AtomOpts {
  id?: string;
  status?: string;
  review_by?: string;
  layer?: string;
  owner?: string;
  strength?: string;
  origin?: string | null;
  signature?: boolean;
  verifierNone?: boolean;
  supersedes?: string[];
  body?: string;
}

export function atomText(o: AtomOpts = {}): string {
  const lines = [
    '---',
    `id: ${o.id ?? ID}`,
    'title: 示例规则',
    `layer: ${o.layer ?? 'team'}`,
    `strength: ${o.strength ?? 'should'}`,
    'kind: practice',
    'volatility: stable',
    `status: ${o.status ?? 'proposed'}`,
    `owner: '${o.owner ?? OWNER}'`,
    'created: 2026-10-08',
    `review_by: ${o.review_by ?? '2027-01-08'}`,
    'evidence:',
    '  - type: memory',
    '    ref: sig-1',
    '    excerpt: 合成摘录',
    'verifier:',
    ...(o.verifierNone === false ? ['  type: replay', '  ref: cases/x/'] : ['  type: none']),
    ...(o.signature === false ? [] : ['signature:', '  type: always']),
    ...(o.origin === null ? [] : [`origin: ${o.origin ?? `proposal/${PID}`}`]),
    ...(o.supersedes ? [`supersedes: [${o.supersedes.join(', ')}]`] : []),
    '---',
    '',
  ];
  return lines.join('\n') + (o.body ?? DEFAULT_BODY);
}

export interface ProposalOpts {
  rationale?: string;
  noJudge?: boolean;
  attempts?: boolean;
  verdict?: 'accept' | 'revise' | 'reject';
  injection?: boolean;
  judgeVendor?: string;
  lastHopVendor?: string;
  hash?: string | null; // null = 缺省
  backend?: string | null;
  stub?: boolean;
  reflectorModel?: string;
  layer?: string;
  targets?: string[];
  evidenceExcerpt?: string;
}

export function proposalYaml(atom: string, o: ProposalOpts = {}): string {
  const hash = o.hash === undefined ? normalizedRuleSha256(atom) : o.hash;
  const judgeVendor = o.judgeVendor ?? 'openai';
  const doc: Record<string, unknown> = {
    id: PID,
    op: 'add',
    targets: o.targets ?? [ID],
    layer: o.layer ?? 'team',
    rationale: o.rationale ?? '合成的理由',
    evidence: [{ sig: 'sig-1', project_key: 'proj-a', excerpt: o.evidenceExcerpt ?? '合成摘录' }],
    budget_delta_bytes: 100,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: 'anthropic',
      vendor: 'anthropic',
      model: o.reflectorModel ?? 'claude-x',
      run_id: 'run-20261008T000000Z-aaaaaa',
      ...(o.backend === null ? {} : { backend: o.backend ?? 'claude' }),
      ...(o.stub ? { stub: true } : {}),
    },
  };
  if (o.attempts) {
    doc['judge_attempts'] = ['codex', 'maas-deepseek', 'glm', 'kimi', 'official-deepseek'].map(
      (hop) => ({ hop, vendor: 'unknown', model: '-', result: 'error:not_configured' }),
    );
  } else if (!o.noJudge) {
    doc['judge'] = {
      hops: [
        {
          hop: 'codex',
          vendor: o.lastHopVendor ?? judgeVendor,
          model: 'gpt-x',
          result: 'ok',
        },
      ],
      provider: 'openai',
      vendor: judgeVendor,
      verdict: o.verdict ?? 'accept',
      overfit_risk: 'low',
      injection_suspected: o.injection ?? false,
      conflicts: [],
      ...(hash === null || hash === undefined ? {} : { rule_sha256: hash }),
    };
  }
  return stringify(doc);
}

/** 复制仓库自带的 kit.toml,换成给定的 canary 成员表与(可选)[lifecycle] 段 */
export function kitToml(opts: { members?: string[]; lifecycle?: string | null } = {}): string {
  let t = readTextSync(fileURLToPath(new URL('../../kit.toml', import.meta.url)));
  const members = opts.members ?? ['@owner-handle', '@alice', '@bob'];
  t = t.replace(
    '[channels.canary.members]\n',
    `[channels.canary.members]\n${members.map((m) => `"${m}" = {}\n`).join('')}`,
  );
  if (opts.lifecycle !== undefined) {
    t = t.replace(
      /\[lifecycle\][\s\S]*?\n\n/,
      opts.lifecycle === null ? '' : `${opts.lifecycle}\n\n`,
    );
  }
  return t;
}

export interface AttestOpts {
  member?: string;
  start?: string;
  end?: string;
  exposure?: number;
  harmful?: number;
  hash?: string;
  channel?: string;
  method?: string | null;
  run?: string;
  rule_id?: string;
}

export function attestFile(atom: string, o: AttestOpts = {}): [string, string] {
  const a: Record<string, unknown> = {
    schema_version: 1,
    rule_id: o.rule_id ?? ID,
    rule_sha256: o.hash ?? normalizedRuleSha256(atom),
    channel: o.channel ?? 'canary',
    member: o.member ?? '@alice',
    window_start: o.start ?? '2026-10-08',
    window_end: o.end ?? '2026-10-22',
    kit_version: '0.1.0',
    collector_versions: {},
    sessions_total: 40,
    exposure_sessions: o.exposure ?? 10,
    exposure_projects: 1,
    fired: 1,
    harmful: o.harmful ?? 0,
    recurrence: 0,
    signal_ids_digest: `sha256:${'0'.repeat(64)}`,
    run_id: o.run ?? 'run-20261023T000000Z-aaaaaa',
  };
  if (o.method !== null) a['method'] = o.method ?? 'signature_proxy_v1';
  const text = `${JSON.stringify(a)}\n`;
  const name = attestFileName({
    member: a['member'] as string,
    window_end: a['window_end'] as string,
    run_id: a['run_id'] as string,
  });
  return [`attest/${a['rule_id'] as string}/${name}`, text];
}

export const digestOf = (text: string): string => `sha256:${sha(text)}`;

export interface RecordOpts {
  from?: string;
  to?: string;
  reason?: string;
  by?: string;
  hash?: string;
  digests?: string[];
  recorded_at?: string;
  run?: string;
  rule_id?: string;
}

export function recordFile(atom: string, o: RecordOpts = {}): [string, string] {
  const r: Record<string, unknown> = {
    schema_version: 1,
    rule_id: o.rule_id ?? ID,
    kind: 'retire',
    reason: o.reason ?? 'manual',
    from_status: o.from ?? 'advisory',
    to_status: o.to ?? 'deprecated',
    ...(o.by !== undefined ? { by: o.by } : {}),
    rule_sha256: o.hash ?? normalizedRuleSha256(atom),
    attest_digests: o.digests ?? [],
    kit_version: '0.1.0',
    run_id: o.run ?? 'run-20261009T000000Z-bbbbbb',
    recorded_at: o.recorded_at ?? '2026-10-09',
    owner: OWNER,
  };
  const name = lifecycleFileName({
    recorded_at: r['recorded_at'] as string,
    run_id: r['run_id'] as string,
  });
  return [`lifecycle/${r['rule_id'] as string}/${name}`, `${JSON.stringify(r)}\n`];
}

import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/redact/index.js';
import {
  RuleHashError,
  checkC4,
  checkC5,
  checkC6,
  checkC7,
  checkC8,
  checkC9,
  ruleSha256,
  type C7Input,
  type C9Input,
} from '../../src/lifecycle/checks.js';
import {
  CANARY,
  SIG1,
  SIG2,
  atomText,
  fakeKey,
  makeAtom,
  makeCase,
  makeProposal,
  sessionRefOf,
} from './fixtures.js';

const WHITE = ['proj-a', 'proj-b'];

describe('C4 层规则', () => {
  const run = (
    over: {
      atom?: Record<string, unknown>;
      proposal?: Record<string, unknown>;
      keys?: readonly string[];
      sess?: ((s: string) => string | undefined) | null;
    } = {},
  ) =>
    checkC4({
      atom: makeAtom(over.atom),
      proposal: makeProposal(over.proposal),
      teamProjectKeys: over.keys ?? WHITE,
      sessionRefOf: over.sess === undefined ? sessionRefOf : over.sess,
    });

  it('合法 team 样例通过', () => {
    expect(run()).toMatchObject({ code: 'C4', ok: true, reason: 'OK' });
  });

  it('personal 层:只给判定(通过),info=LAYER_PERSONAL;白名单为空也一样', () => {
    const r = run({ atom: { layer: 'personal' }, proposal: { layer: 'personal' }, keys: [] });
    expect(r.ok).toBe(true);
    expect(r.info).toBe('LAYER_PERSONAL');
  });

  it('白名单为空 ⇒ 声称 team 的一律拒(TEAM_WHITELIST_EMPTY + 每条证据都不在白名单)', () => {
    const r = run({ keys: [] });
    expect(r.reasons).toEqual(['TEAM_WHITELIST_EMPTY', 'PROJECT_NOT_WHITELISTED']);
  });

  it('kind=preference 却是 team → PREFERENCE_NOT_PERSONAL', () => {
    const r = run({ atom: { kind: 'preference' } });
    expect(r.reasons).toEqual(['PREFERENCE_NOT_PERSONAL']);
  });

  it('只有一个 project_key → TEAM_PROJECTS_LT_2', () => {
    const r = run({
      proposal: {
        evidence: [
          { sig: SIG1, project_key: 'proj-a', excerpt: 'x' },
          { sig: SIG2, project_key: 'proj-a', excerpt: 'y' },
        ],
      },
    });
    expect(r.reasons).toEqual(['TEAM_PROJECTS_LT_2']);
  });

  it('某个 project_key 不在白名单 → PROJECT_NOT_WHITELISTED(指到那一条)', () => {
    const r = run({ keys: ['proj-a'] });
    expect(r.reasons).toEqual(['PROJECT_NOT_WHITELISTED']);
    expect(r.fields).toEqual(['proposal.evidence[1].project_key']);
  });

  it('两条证据同一会话 → TEAM_SESSIONS_LT_2', () => {
    const r = run({ sess: () => 's_00000000000000aa' });
    expect(r.reasons).toEqual(['TEAM_SESSIONS_LT_2']);
  });

  it('会话反查不到 → unverifiable(退出 4),不是通过', () => {
    const r = run({ sess: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['SESSION_LOOKUP_MISSING']);
    expect(r.unverifiable).toBe(true);
  });

  it('CI 模式(sessionRefOf=null)不查会话数,白名单与项目数照查', () => {
    expect(run({ sess: null }).ok).toBe(true);
    expect(run({ sess: null, keys: ['proj-a'] }).reasons).toEqual(['PROJECT_NOT_WHITELISTED']);
  });

  it('原子与提案 layer 不一致 / org、project 层 → 拒', () => {
    expect(run({ atom: { layer: 'personal' } }).reasons).toEqual(['LAYER_MISMATCH']);
    const r = run({ atom: { layer: 'org' }, proposal: { layer: 'org' } });
    expect(r.reasons).toEqual(['LAYER_UNSUPPORTED']);
  });
});

describe('C5 评审记录', () => {
  const run = (over: Record<string, unknown> = {}, judge: Record<string, unknown> = {}) =>
    checkC5({ proposal: makeCase({ proposal: over, judge }).proposal });

  it('合法样例通过', () => {
    expect(run()).toMatchObject({ code: 'C5', ok: true, reason: 'OK' });
  });

  it('没有 judge、也没有 attempts → JUDGE_MISSING', () => {
    const r = checkC5({ proposal: makeProposal({ judge: undefined }) });
    expect(r.reasons).toEqual(['JUDGE_MISSING']);
  });

  it('只有 judge_attempts 没有 judge → JUDGE_PENDING(不是 JUDGE_MISSING)', () => {
    const hops = ['codex', 'maas-deepseek', 'glm', 'kimi', 'official-deepseek'].map((hop) => ({
      hop,
      vendor: 'unknown',
      model: '-',
      result: 'error:not_configured',
    }));
    const r = checkC5({ proposal: makeProposal({ judge: undefined, judge_attempts: hops }) });
    expect(r.reasons).toEqual(['JUDGE_PENDING']);
  });

  it('verdict=revise / reject → VERDICT_NOT_ACCEPT', () => {
    expect(run({}, { verdict: 'revise' }).reasons).toEqual(['VERDICT_NOT_ACCEPT']);
    expect(run({}, { verdict: 'reject' }).reasons).toEqual(['VERDICT_NOT_ACCEPT']);
  });

  it('同厂商(大小写 / 首尾空白不能绕过)→ VENDOR_NOT_CROSS', () => {
    // 反思器 anthropic;裁判写成 " Anthropic ":归一化后同厂商
    const hop = { hop: 'codex', vendor: ' Anthropic ', model: 'x', result: 'skipped:same-vendor' };
    const ok = { hop: 'maas-deepseek', vendor: ' Anthropic ', model: 'y', result: 'ok' };
    const p = makeProposal({
      judge: {
        hops: [hop, ok].map((h, i) => (i === 0 ? h : { ...h, hop: 'maas-deepseek' })),
        provider: 'maas-deepseek',
        vendor: ' Anthropic ',
        verdict: 'accept',
        overfit_risk: 'low',
        injection_suspected: false,
        conflicts: [],
      },
    });
    // schema 只拒完全相等的串,所以带空白 / 大写的同厂商能解析通过——这正是 C5 要补的洞
    expect(checkC5({ proposal: p }).reasons).toContain('VENDOR_NOT_CROSS');
  });

  it('归一化是双向的:大小写 / 空白不同但实为不同厂商,照样通过', () => {
    const r = run(
      {},
      {
        vendor: ' OpenAI ',
        hops: [{ hop: 'codex', vendor: 'OPENAI', model: 'gpt-6.1-sol', result: 'ok' }],
      },
    );
    expect(r.ok).toBe(true);
    const base = makeCase().proposal;
    const p = { ...base, reflector: { ...base.reflector, vendor: ' Anthropic ' } };
    expect(checkC5({ proposal: p }).ok).toBe(true);
  });

  it('裁判厂商是自报值:judge.vendor 与最后一跳 vendor 一起改,但模型串对不上 → JUDGE_VENDOR_UNPROVEN', () => {
    // 反思器 anthropic;裁判声称 google,但最后一跳模型是 gpt-*(openai)
    const r = run(
      {},
      {
        vendor: 'google',
        hops: [{ hop: 'codex', vendor: 'google', model: 'gpt-6.1-sol', result: 'ok' }],
      },
    );
    expect(r.reasons).toEqual(['JUDGE_VENDOR_UNPROVEN']);
    // 模型串推不出厂商(unknown)同样拒
    const u = run(
      {},
      { hops: [{ hop: 'codex', vendor: 'openai', model: 'mystery-model', result: 'ok' }] },
    );
    expect(u.reasons).toEqual(['JUDGE_VENDOR_UNPROVEN']);
  });

  it('厂商是 unknown / 非内置 → 无法证明不同 → VENDOR_NOT_CROSS', () => {
    const unknown = run(
      {},
      { vendor: 'unknown', hops: [{ hop: 'codex', vendor: 'unknown', model: 'x', result: 'ok' }] },
    );
    expect(unknown.reasons).toContain('VENDOR_NOT_CROSS');
  });

  it('reflector.backend 缺失 → REFLECTOR_BACKEND_MISSING', () => {
    const base = makeCase().proposal;
    const { backend: _b, ...reflector } = base.reflector;
    void _b;
    const r = checkC5({ proposal: { ...base, reflector } });
    expect(r.reasons).toEqual(['REFLECTOR_BACKEND_MISSING']);
  });

  it('reflector.vendor 与 deriveVendor 复算不一致 → REFLECTOR_VENDOR_MISMATCH', () => {
    // 声称 vendor=google(与裁判 openai 不同),但 backend=claude 只能推出 anthropic
    const base = makeCase().proposal;
    const p = { ...base, reflector: { ...base.reflector, vendor: 'google' } };
    expect(checkC5({ proposal: p }).reasons).toEqual(['REFLECTOR_VENDOR_MISMATCH']);
  });

  it('stub=true 不得进入合并流程 → STUB_PROPOSAL', () => {
    const base = makeCase().proposal;
    const p = { ...base, reflector: { ...base.reflector, stub: true as const } };
    expect(checkC5({ proposal: p }).reasons).toEqual(['STUB_PROPOSAL']);
  });

  it('judge.provider 不等于最后一跳槽位 id → JUDGE_PROVIDER_MISMATCH', () => {
    expect(run({}, { provider: 'glm' }).reasons).toEqual(['JUDGE_PROVIDER_MISMATCH']);
  });

  it('最后一跳厂商 ≠ judge.vendor → JUDGE_LAST_HOP_VENDOR_MISMATCH', () => {
    const r = run(
      {},
      {
        hops: [{ hop: 'codex', vendor: 'google', model: 'gpt-6.1-sol', result: 'ok' }],
        vendor: 'openai',
      },
    );
    expect(r.reasons).toEqual(['JUDGE_LAST_HOP_VENDOR_MISMATCH']);
  });

  it('最后一跳不是 ok(绕过 schema 的手改记录)→ JUDGE_LAST_HOP_NOT_OK', () => {
    const base = makeCase().proposal;
    const p = {
      ...base,
      judge: {
        ...base.judge!,
        hops: [{ hop: 'codex' as const, vendor: 'openai', model: 'x', result: 'error:x' }],
      },
    };
    expect(checkC5({ proposal: p }).reasons).toEqual(['JUDGE_LAST_HOP_NOT_OK']);
  });

  it('覆盖层厂商表非法 → VENDOR_OVERRIDES_INVALID(不抛)', () => {
    const r = checkC5({
      proposal: makeCase().proposal,
      vendorOverrides: { gpt: 'anthropic' },
    });
    expect(r.reasons).toEqual(['VENDOR_OVERRIDES_INVALID']);
  });
});

describe('C6 规则文本与评审绑定', () => {
  it('合法样例通过', () => {
    const { text, proposal } = makeCase();
    expect(checkC6({ judge: proposal.judge, atomText: text })).toMatchObject({
      code: 'C6',
      ok: true,
    });
  });

  it('哈希对 status / review_by 归一化:晋升改这两行不改哈希', () => {
    const { atom, text } = makeCase();
    const promoted = atomText(atom, { status: 'active', review_by: '2027-06-01' });
    expect(promoted).not.toBe(text);
    expect(ruleSha256(promoted)).toBe(ruleSha256(text));
  });

  it('晋升后的文本仍可通过 C6(绑定的是归一化哈希)', () => {
    const { atom, proposal } = makeCase();
    const promoted = atomText(atom, { status: 'advisory', review_by: '2027-06-01' });
    expect(checkC6({ judge: proposal.judge, atomText: promoted }).ok).toBe(true);
  });

  it('正文被改一个字 → RULE_SHA256_MISMATCH', () => {
    const { atom, proposal } = makeCase();
    const changed = atomText(makeAtom({}, { do: `${atom.body.do}多一句。` }));
    const r = checkC6({ judge: proposal.judge, atomText: changed });
    expect(r.reasons).toEqual(['RULE_SHA256_MISMATCH']);
    expect(ruleSha256(changed)).not.toBe(ruleSha256(atomText(atom)));
  });

  it('frontmatter 里别的字段被改(如 strength)也变哈希', () => {
    const { text } = makeCase();
    expect(ruleSha256(text.replace('layer: team', 'layer: personal'))).not.toBe(ruleSha256(text));
  });

  it('judge 缺失 / 没有 rule_sha256 → 拒(⑨A:必填)', () => {
    const { text } = makeCase();
    expect(checkC6({ judge: undefined, atomText: text }).reasons).toEqual(['JUDGE_MISSING']);
    const noHash = makeCase({ judge: { rule_sha256: undefined } }).proposal.judge;
    expect(checkC6({ judge: noHash, atomText: text }).reasons).toEqual(['RULE_SHA256_MISSING']);
  });

  it('文本无法哈希(无 frontmatter / status 不是恰好一行)→ RULE_TEXT_UNHASHABLE', () => {
    const { text, proposal } = makeCase();
    for (const bad of [
      'no frontmatter',
      text.replace('status: proposed\n', ''),
      text.replace('status: proposed\n', 'status: proposed\nstatus: active\n'),
      text.replace('review_by: 2027-01-10\n', ''),
    ]) {
      expect(() => ruleSha256(bad)).toThrow(RuleHashError);
      expect(checkC6({ judge: proposal.judge, atomText: bad }).reasons).toEqual([
        'RULE_TEXT_UNHASHABLE',
      ]);
    }
  });

  it('status / review_by 行尾追加注释会改变哈希(不能把载荷藏在注释里)', () => {
    const { text } = makeCase();
    const withComment = text.replace('status: proposed', 'status: proposed # 额外内容');
    expect(withComment).not.toBe(text);
    expect(ruleSha256(withComment)).not.toBe(ruleSha256(text));
    const rb = text.replace('review_by: 2027-01-10', 'review_by: 2027-01-10 # x');
    expect(ruleSha256(rb)).not.toBe(ruleSha256(text));
  });

  it('块标量 / 带引号的键 / 流式写法 → 无法哈希(fail-closed),不按另一种格式猜', () => {
    const { text } = makeCase();
    for (const bad of [
      text.replace('status: proposed', 'status: |-\n  proposed'),
      text.replace('status: proposed', '"status": proposed'),
      text.replace('status: proposed', 'status: [proposed]'),
    ]) {
      expect(() => ruleSha256(bad)).toThrow(RuleHashError);
    }
  });

  it('带引号的值仍可归一化', () => {
    const { text } = makeCase();
    expect(ruleSha256(text.replace('status: proposed', "status: 'advisory'"))).toBe(
      ruleSha256(text),
    );
  });

  it('CRLF / 末尾空行不影响哈希', () => {
    const { text } = makeCase();
    expect(ruleSha256(text.replace(/\n/g, '\r\n') + '\r\n\r\n')).toBe(ruleSha256(text));
  });
});

describe('C7 id 与去重', () => {
  const EXISTING = {
    id: 'other-rule',
    do: '部署之前先确认数据库迁移已经全部应用并且回滚脚本可用。',
    why: '漏掉迁移会让新版本启动即崩溃,影响线上全部用户。',
    status: 'active',
  };
  const base = (over: Partial<C7Input> = {}): C7Input => ({
    atom: makeAtom(),
    mode: 'adopt',
    existingIds: new Set(['other-rule']),
    existingAtoms: [EXISTING],
    stagedIds: new Set(),
    stagedAtoms: [],
    tombstoneIds: new Set(),
    ...over,
  });

  it('合法样例通过', () => {
    expect(checkC7(base())).toMatchObject({ code: 'C7', ok: true, reason: 'OK' });
  });

  it('id 已在仓库 → ID_EXISTS_IN_REPO', () => {
    const r = checkC7(base({ existingIds: new Set(['run-lint-before-commit']) }));
    expect(r.reasons).toEqual(['ID_EXISTS_IN_REPO']);
  });

  it('id 已在其它暂存运行 → ID_EXISTS_IN_STAGING', () => {
    const r = checkC7(base({ stagedIds: new Set(['run-lint-before-commit']) }));
    expect(r.reasons).toEqual(['ID_EXISTS_IN_STAGING']);
  });

  it('id 在退役记录(墓碑)里 → ID_TOMBSTONED,即使原子文件已不在仓库', () => {
    const r = checkC7(base({ tombstoneIds: new Set(['run-lint-before-commit']) }));
    expect(r.reasons).toEqual(['ID_TOMBSTONED']);
  });

  it('正文与已有原子近重复 → NEAR_DUPLICATE,info 带对方 id', () => {
    const dup = makeAtom({}, { do: EXISTING.do, why: EXISTING.why });
    const r = checkC7(base({ atom: dup }));
    expect(r.reasons).toEqual(['NEAR_DUPLICATE']);
    expect(r.info).toBe('DUPLICATE_OF:other-rule');
  });

  it('与其它暂存运行里的原子近重复(id 不同)→ NEAR_DUPLICATE', () => {
    const dup = makeAtom({}, { do: EXISTING.do, why: EXISTING.why });
    const r = checkC7(base({ atom: dup, existingAtoms: [], stagedAtoms: [EXISTING] }));
    expect(r.reasons).toEqual(['NEAR_DUPLICATE']);
    // 正向对照:暂存池里没有它时通过
    expect(checkC7(base({ atom: dup, existingAtoms: [], stagedAtoms: [] })).ok).toBe(true);
  });

  it('与已退役 / 弃用原子近重复 → NEAR_DUPLICATE_RESURRECTS_RETIRED', () => {
    const dup = makeAtom({}, { do: EXISTING.do, why: EXISTING.why });
    const r = checkC7(base({ atom: dup, existingAtoms: [{ ...EXISTING, status: 'retired' }] }));
    expect(r.reasons).toEqual(['NEAR_DUPLICATE_RESURRECTS_RETIRED']);
  });

  it('签名完全相同也算重复', () => {
    const r = checkC7(
      base({
        existingAtoms: [{ ...EXISTING, signature: { type: 'phrase', pattern: 'git commit' } }],
      }),
    );
    expect(r.reasons).toEqual(['NEAR_DUPLICATE']);
  });

  it('promote 模式:自己的 id 在仓库里不算冲突,也不与自己比相似度;墓碑照查', () => {
    const self = { id: 'run-lint-before-commit', do: makeAtom().body.do, why: makeAtom().body.why };
    const ok = checkC7(
      base({
        mode: 'promote',
        existingIds: new Set(['run-lint-before-commit']),
        existingAtoms: [self],
        stagedIds: new Set(['run-lint-before-commit']),
      }),
    );
    expect(ok.ok).toBe(true);
    // 正向对照:同样的输入在 adopt 模式下必须被拒
    const adopt = checkC7(
      base({ existingIds: new Set(['run-lint-before-commit']), existingAtoms: [self] }),
    );
    expect(adopt.reasons).toEqual(['ID_EXISTS_IN_REPO', 'NEAR_DUPLICATE']);
    const tomb = checkC7(
      base({ mode: 'promote', tombstoneIds: new Set(['run-lint-before-commit']) }),
    );
    expect(tomb.reasons).toEqual(['ID_TOMBSTONED']);
  });
});

describe('C8 脱敏复扫', () => {
  const redactor = createRedactor({ timeout_ms: 5000 });
  const run = (atom = makeAtom(), proposal = makeProposal(), r = redactor) =>
    checkC8({ atom, proposal, redactor: r });

  it('合法样例通过', () => {
    expect(run()).toMatchObject({ code: 'C8', ok: true, reason: 'OK' });
  });

  it('正向对照:拼装出的密钥串确实被 pass2 判为残留(否则下面的负向断言没意义)', () => {
    expect(redactor.pass2(`token ${fakeKey()}`).clean).toBe(false);
  });

  it('原子正文 / 证据 / 提案 rationale 里的密钥 → REDACTION_RESIDUAL,指到字段,不回显', () => {
    const k = fakeKey();
    const a = run(makeAtom({}, { do: `用 ${k} 调用 ${CANARY}` }));
    expect(a.reasons).toEqual(['REDACTION_RESIDUAL']);
    expect(a.fields).toEqual(['body.do']);
    expect(JSON.stringify(a)).not.toContain(k);
    expect(JSON.stringify(a)).not.toContain(CANARY);
    const b = run(makeAtom(), makeProposal({ rationale: `key=${k}` }));
    expect(b.fields).toEqual(['proposal.rationale']);
    const c = run(makeAtom({ origin: `proposal/${k}` }));
    expect(c.fields).toEqual(['origin']);
  });

  it('其余会被持久化的字符串字段同样要扫(evidence.type / verifier.ref / judge.conflicts / 模型串 / project_key)', () => {
    const k = fakeKey('extra');
    const base = makeCase();
    const field = (atomOver: Record<string, unknown>, propOver: Record<string, unknown>) =>
      run(makeAtom(atomOver), makeProposal(propOver)).fields;
    const ev = makeAtom().fm.evidence;
    expect(field({ evidence: [{ ...ev[0]!, type: k }, ev[1]!] }, {})).toEqual(['evidence[0].type']);
    expect(field({ verifier: { type: 'none', ref: k } }, {})).toEqual(['verifier.ref']);
    expect(field({}, { judge: { ...base.proposal.judge!, conflicts: [k] } })).toEqual([
      'judge.conflicts[0]',
    ]);
    const hop = { ...base.proposal.judge!.hops[0]!, model: k };
    expect(field({}, { judge: { ...base.proposal.judge!, hops: [hop] } })).toEqual([
      'judge.hops[0].model',
    ]);
    const r = base.proposal.reflector;
    expect(field({}, { reflector: { ...r, model: k } })).toEqual(['reflector.model']);
    const pe = base.proposal.evidence;
    expect(field({}, { evidence: [{ ...pe[0]!, project_key: k }, pe[1]!] })).toEqual([
      'proposal.evidence[0].project_key',
    ]);
  });

  it('扫描抛异常按不干净处理 → REDACTION_SCAN_ERROR(每个字段一次)', () => {
    const boom = {
      pass2: () => {
        throw new Error('timeout');
      },
    };
    const r = run(makeAtom(), makeProposal(), boom as never);
    expect(r.reason).toBe('REDACTION_SCAN_ERROR');
    expect(r.fields).toContain('body.do');
    expect(r.fields).toContain('proposal.rationale');
  });

  it('pass2 返回异常形状(clean 不是 true)也按不干净处理', () => {
    const odd = { pass2: () => ({ hits: [] }) };
    expect(run(makeAtom(), makeProposal(), odd as never).reason).toBe('REDACTION_RESIDUAL');
  });
});

describe('C9 路径与补丁安全', () => {
  const GOOD: C9Input = {
    runId: 'run-20261012T080000Z-abc123',
    files: [
      { path: 'rules/team/run-lint-before-commit.md', content: 'line one\n' },
      { path: 'proposals/2026-10-12-001.yaml', content: 'id: x\n' },
    ],
    fsFacts: [
      { path: 'run-dir', kind: 'dir', expect: 'dir', nlink: 3 },
      { path: 'rules/team/run-lint-before-commit.md', kind: 'file', expect: 'file', nlink: 1 },
    ],
  };
  const run = (over: Partial<C9Input>) => checkC9({ ...GOOD, ...over });

  it('合法样例通过', () => {
    expect(checkC9(GOOD)).toMatchObject({ code: 'C9', ok: true, reason: 'OK' });
  });

  const BAD_PATHS = [
    'Rules/team/x.md',
    'rules/../etc/passwd',
    'rules//x.md',
    './rules/x.md',
    '/abs/path.md',
    'rules/x y.md',
    'rules\\x.md',
    'rules/x.md\0',
  ];
  for (const p of BAD_PATHS) {
    it(`PATH_UNSAFE:${JSON.stringify(p)}`, () => {
      const r = run({ files: [{ path: p, content: 'ok\n' }] });
      expect(r.reasons).toEqual(['PATH_UNSAFE']);
    });
  }

  const BAD_CONTENT: readonly [string, string][] = [
    ['空文件', ''],
    ['含 CR', 'a\r\nb\n'],
    ['缺结尾换行', 'abc'],
    ['行尾空白', 'abc \n'],
    ['行尾 TAB', 'abc\t\n'],
  ];
  for (const [name, content] of BAD_CONTENT) {
    it(`PATCH_CONTENT_UNSAFE:${name}`, () => {
      const r = run({ files: [{ path: 'rules/team/x.md', content }] });
      expect(r.reasons).toEqual(['PATCH_CONTENT_UNSAFE']);
    });
  }

  it('run_id 含路径穿越 / 空 → RUN_ID_INVALID', () => {
    for (const id of ['../x', 'a/b', '', '.hidden', 'x'.repeat(65)]) {
      expect(run({ runId: id }).reasons, id).toEqual(['RUN_ID_INVALID']);
    }
  });

  it('符号链接(目录或文件)→ FS_SYMLINK', () => {
    const r = run({
      fsFacts: [
        { path: 'run-dir', kind: 'symlink', expect: 'dir', nlink: 1 },
        { path: 'f', kind: 'symlink', expect: 'file', nlink: 1 },
      ],
    });
    expect(r.reasons).toEqual(['FS_SYMLINK']);
    expect(r.fields).toEqual(['run-dir', 'f']);
  });

  it('硬链接(文件 nlink>1)→ FS_HARDLINK;目录的 nlink>1 是正常的', () => {
    expect(
      run({ fsFacts: [{ path: 'f', kind: 'file', expect: 'file', nlink: 2 }] }).reasons,
    ).toEqual(['FS_HARDLINK']);
    expect(run({ fsFacts: [{ path: 'd', kind: 'dir', expect: 'dir', nlink: 7 }] }).ok).toBe(true);
  });

  it('期望文件却是目录 / 其它类型 → FS_NOT_REGULAR', () => {
    const r = run({
      fsFacts: [
        { path: 'f', kind: 'dir', expect: 'file', nlink: 1 },
        { path: 'd', kind: 'other', expect: 'dir', nlink: 1 },
      ],
    });
    expect(r.reasons).toEqual(['FS_NOT_REGULAR']);
  });
});

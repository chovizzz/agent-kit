// A17 反思器越权夹具:在合成 git 仓库里,让"反思器"改 hooks/ 等禁区文件、改已有 active 原子的治理字段、
// 新增非 proposed / 带边的原子,必须被路径守卫 / G1 / G2(/G4)按**具体诊断码**拒绝(label=kit:reflector)。
// 防假绿:合法对照(只新增 proposed 原子 + 提案文件)必须零诊断;期望码是精确集合(toEqual),不是"有红灯就行";
// 先查 dist 不陈旧;仓库是现场合成的,不读任何真实内容。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Reporter, cleanEnv, makeCtx, mkTmp, parseCommon, rmTmp, run, runMain } from './common.mjs';
import { freshDist, importDist } from './accept-p1.mjs';

const atomText = (o = {}) =>
  [
    '---',
    `id: ${o.id ?? 'sample-atom'}`,
    'title: 示例规则',
    'layer: team',
    `strength: ${o.strength ?? 'should'}`,
    'kind: practice',
    'volatility: stable',
    `status: ${o.status ?? 'proposed'}`,
    "owner: '@owner-handle'",
    'created: 2026-10-08',
    `review_by: ${o.review_by ?? '2027-01-08'}`,
    'evidence:',
    '  - type: memory',
    "    ref: 'sha256:0000000000000000000000000000000000000000000000000000000000000001'",
    '    excerpt: 合成的证据摘录',
    'verifier:',
    '  type: replay',
    '  ref: cases/x/',
    'signature:',
    '  type: always',
    ...(o.extra ?? []),
    '---',
    '',
    '**做**:做某件具体的事。',
    '**为什么**:因为某个原因。',
    '**怎么验**:用某种方式验证。',
    '',
  ].join('\n');

// 合成提案:守卫(kit:reflector)只看 reflector.backend / reflector.stub
const proposalText = (o = {}) =>
  [
    `id: ${o.id ?? 'p-new'}`,
    'body: a',
    ...(o.omitReflector
      ? []
      : [
          'reflector:',
          '  provider: codex',
          '  vendor: openai',
          '  model: gpt-example',
          '  run_id: run-1',
          ...(o.backend === null ? [] : [`  backend: ${o.backend ?? 'codex'}`]),
          ...(o.stub ? ['  stub: true'] : []),
        ]),
    '',
  ].join('\n');

const ATOM = 'rules/team/sample-atom.md';
export const BASE_FILES = {
  'kit.toml': '[kit]\nname = "demo"\n',
  CODEOWNERS: 'rules/** @owner-handle\n',
  'hooks/h1/hook.yaml': 'id: h1\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'adapters/claude/index.ts': 'export {};\n',
  'attest/a/b.json': '{}\n',
  'cases/x/case.yaml': 'id: x\n',
  'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n',
  'proposals/p1.yaml': 'id: p1\n',
  [ATOM]: atomText({ status: 'active' }),
};

/** 期望码是精确集合;null = 该文件在 head 里被删除。 */
export const CASES = [
  {
    name: 'C0 合法对照:新增 proposed 原子 + 提案文件',
    head: {
      'rules/team/new-rule.md': atomText({ id: 'new-rule' }),
      'proposals/p2.yaml': proposalText({ id: 'p2' }),
    },
    codes: [],
  },
  ...[
    ['hooks/', { 'hooks/h1/hook.yaml': 'id: evil\n' }],
    ['kit.toml', { 'kit.toml': '[kit]\nname = "evil"\n' }],
    ['CODEOWNERS', { CODEOWNERS: '* @attacker\n' }],
    ['.github/', { '.github/workflows/ci.yml': 'name: evil\n' }],
    ['adapters/', { 'adapters/claude/index.ts': 'export const x = 1;\n' }],
    ['attest/', { 'attest/a/b.json': '{"evil":1}\n' }],
    ['删除 hooks/ 里的文件', { 'hooks/h1/hook.yaml': null }],
  ].map(([n, head]) => ({ name: `P 触碰 ${n}`, head, codes: ['GUARD_PATH_FORBIDDEN'] })),
  {
    name: 'P 触碰允许区之外(docs/)',
    head: { 'docs/x.md': 'x\n' },
    codes: ['GUARD_PATH_OUTSIDE_ALLOWED'],
  },
  {
    name: 'G2 改已有 active 原子 status → retired',
    head: { [ATOM]: atomText({ status: 'retired' }) },
    codes: ['GUARD_G2_STATUS_CHANGED', 'GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'G2 改已有 active 原子 status → advisory',
    head: { [ATOM]: atomText({ status: 'advisory' }) },
    codes: ['GUARD_G2_STATUS_CHANGED', 'GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'G2 给已有 active 原子加 disables',
    head: { [ATOM]: atomText({ status: 'active', extra: ['disables: [other-atom]'] }) },
    codes: ['GUARD_G2_FIELD_LOCKED', 'GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'G2 改已有 active 原子 strength',
    head: { [ATOM]: atomText({ status: 'active', strength: 'must' }) },
    codes: ['GUARD_G2_FIELD_LOCKED', 'GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'G2 延长已有 active 原子 review_by',
    head: { [ATOM]: atomText({ status: 'active', review_by: '2099-01-01' }) },
    codes: ['GUARD_G2_REVIEW_BY_EXTENDED', 'GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'G1 新增原子 status=active',
    head: { 'rules/team/evil-rule.md': atomText({ id: 'evil-rule', status: 'active' }) },
    codes: ['GUARD_G1_NEW_ATOM_NOT_PROPOSED'],
  },
  {
    name: 'G1 新增原子带 overrides',
    head: {
      'rules/team/evil-rule.md': atomText({ id: 'evil-rule', extra: ['overrides: [sample-atom]'] }),
    },
    codes: ['GUARD_G1_NEW_ATOM_HAS_EDGES'],
  },
  {
    name: 'G4 删除已有 active 原子(不经退役)',
    head: { [ATOM]: null },
    codes: ['GUARD_G4_DELETE_NOT_RETIRED', 'GUARD_PATH_EXISTING_DELETED'],
  },
  {
    // D7(2026-10-22 用户定):kit:reflector 对 rules/ skills/ cases/ 只许新增;原 N1(改正文放行)现钉住新语义:被拒
    name: 'N1 仅改已有 active 原子正文 → 被拒(D7:反思器只许新增,不许改既有文件)',
    head: { [ATOM]: atomText({ status: 'active' }).replace('做某件具体的事', '做另一件事') },
    codes: ['GUARD_PATH_EXISTING_MODIFIED'],
    policy: true,
  },
  {
    name: 'D7 修改既有 skills/ 文件',
    head: { 'skills/demo/SKILL.md': '---\nname: demo\n---\n改了\n' },
    codes: ['GUARD_PATH_EXISTING_MODIFIED'],
  },
  {
    name: 'D7 删除既有 cases/ 文件',
    head: { 'cases/x/case.yaml': null },
    codes: ['GUARD_PATH_EXISTING_DELETED'],
  },
  {
    name: 'D7 对照:纯新增 skill + case 放行',
    head: {
      'skills/new/SKILL.md': '---\nname: new\n---\nbody\n',
      'cases/new/case.yaml': 'id: new\n',
    },
    codes: [],
  },
  {
    name: '#24 新增提案缺 reflector.backend',
    head: { 'proposals/p2.yaml': proposalText({ id: 'p2', backend: null }) },
    codes: ['GUARD_PROPOSAL_BACKEND_MISSING'],
  },
  {
    name: '#24 新增提案 reflector.stub: true',
    head: { 'proposals/p2.yaml': proposalText({ id: 'p2', stub: true }) },
    codes: ['GUARD_PROPOSAL_STUB'],
  },
];

function git(dir, args, env) {
  const ident = [
    '-c',
    'user.name=a17',
    '-c',
    'user.email=a17@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'maintenance.auto=false',
    '-c',
    'gc.auto=0',
  ];
  const r = run('git', [...ident, ...args], { cwd: dir, env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败:${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (text === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

async function a17(argv) {
  const R = new Reporter('A17');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);
  const fresh = freshDist(ctx);
  if (!fresh.ok) {
    R.notRun(fresh.why);
    return R.exit();
  }
  const guards = await importDist(ctx, 'guards/index.js');
  const paths = await importDist(ctx, 'io/paths.js');
  const tmp = mkTmp(ctx, 'a17');
  let n = 0;
  try {
    const gitHome = path.join(tmp, 'githome');
    fs.mkdirSync(gitHome, { recursive: true });
    // 守卫的 git 出口只接受 GIT_* / HOME(在 KIT_TMP 内)/ LANG 等;PATH 另由 exec 默认提供
    const guardEnv = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: gitHome,
      GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z',
    };
    const gitEnv = cleanEnv(guardEnv);
    for (const c of CASES) {
      const dir = path.join(tmp, `repo-${n++}`);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, ['init', '--quiet', '--template='], gitEnv);
      git(dir, ['config', 'maintenance.auto', 'false'], gitEnv);
      git(dir, ['config', 'gc.auto', '0'], gitEnv);
      writeFiles(dir, BASE_FILES);
      git(dir, ['add', '-A'], gitEnv);
      git(dir, ['commit', '--quiet', '-m', 'base'], gitEnv);
      git(dir, ['tag', 'kit-base'], gitEnv);
      writeFiles(dir, c.head);
      git(dir, ['add', '-A'], gitEnv);
      git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'head'], gitEnv);
      git(dir, ['tag', 'kit-head'], gitEnv);
      const io = paths.createIoContext({
        cwd: dir,
        root: dir,
        env: { KIT_TMP: tmp, PATH: '/usr/bin:/bin' },
      });
      let codes;
      try {
        const res = guards.runGuards({
          git: guards.createGuardGit(io, dir, guardEnv),
          base: 'kit-base',
          head: 'kit-head',
          label: 'kit:reflector',
        });
        codes = [
          ...new Set(res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)),
        ].sort();
      } catch (e) {
        R.notRun(
          `${c.name}:守卫没能运行(${e?.constructor?.name ?? 'Error'}: ${String(e?.message).slice(0, 160)})`,
        );
        continue;
      }
      const want = [...c.codes].sort();
      if (JSON.stringify(codes) === JSON.stringify(want))
        R.pass(`${c.name} => ${want.length ? want.join(',') : '零诊断'}`);
      else R.fail(`${c.name}:期望 [${want.join(',')}],实际 [${codes.join(',')}]`);
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A17', () => a17(process.argv.slice(2)));

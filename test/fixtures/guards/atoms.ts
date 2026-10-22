/** 守卫测试用的合成原子文本。一律合成,无真实内容。 */

export interface AtomSpec {
  id?: string;
  status?: string;
  review_by?: string;
  title?: string;
  /** 追加到 frontmatter 末尾的原样行(用来造重复键、别名等) */
  extraLines?: readonly string[];
  /** 整体替换正文 */
  body?: string;
  /** 换行符:默认 LF */
  eol?: '\n' | '\r\n' | '\r';
  bom?: boolean;
  /** 不输出 status 行 */
  omitStatus?: boolean;
}

export const DEFAULT_BODY =
  '**做**:做某件具体的事。\n**为什么**:因为某个原因。\n**怎么验**:用某种方式验证。\n';

export function atom(spec: AtomSpec = {}): string {
  const lines = [
    '---',
    `id: ${spec.id ?? 'sample-atom'}`,
    `title: ${spec.title ?? '示例规则'}`,
    'layer: team',
    'strength: should',
    'kind: practice',
    'volatility: stable',
    ...(spec.omitStatus ? [] : [`status: ${spec.status ?? 'proposed'}`]),
    "owner: '@owner-handle'",
    'created: 2026-10-08',
    `review_by: ${spec.review_by ?? '2027-01-08'}`,
    'evidence:',
    '  - type: memory',
    "    ref: 'sha256:0000000000000000000000000000000000000000000000000000000000000001'",
    '    excerpt: 合成的证据摘录',
    'verifier:',
    '  type: replay',
    '  ref: cases/x/',
    'signature:',
    '  type: always',
    ...(spec.extraLines ?? []),
    '---',
    '',
  ];
  const eol = spec.eol ?? '\n';
  const body = (spec.body ?? DEFAULT_BODY).replace(/\n/g, eol);
  return `${spec.bom ? '\uFEFF' : ''}${lines.join(eol)}${body}`;
}

export const ATOM_PATH = 'rules/general/sample-atom.md';
export const OTHER_PATH = 'rules/general/other-atom.md';

/** 基线仓库的公共文件(非原子文件,用来验证「别的文件改动」)。 */
export const COMMON_FILES = {
  'kit.toml': '[kit]\nname = "demo"\n',
  CODEOWNERS: 'rules/** @owner-handle\n',
  'hooks/h1/hook.yaml': 'id: h1\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'adapters/claude/index.ts': 'export {};\n',
  'cases/x/case.yaml': 'id: x\n',
  'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n',
  'proposals/p1.yaml': 'id: p1\n',
} as const;

export interface ProposalSpec {
  id?: string;
  /** 缺省 'codex';null = 不写 backend 行 */
  backend?: string | null;
  stub?: boolean;
  /** 不写整个 reflector 块 */
  omitReflector?: boolean;
}

/** 合成提案(守卫只看 reflector.backend / reflector.stub,其余字段随意)。 */
export function proposal(spec: ProposalSpec = {}): string {
  const backend = spec.backend === undefined ? 'codex' : spec.backend;
  const lines = [`id: ${spec.id ?? 'p-new'}`, 'body: a'];
  if (!spec.omitReflector) {
    lines.push(
      'reflector:',
      '  provider: codex',
      '  vendor: openai',
      '  model: gpt-example',
      '  run_id: run-1',
    );
    if (backend !== null) lines.push(`  backend: ${backend}`);
    if (spec.stub === true) lines.push('  stub: true');
  }
  return `${lines.join('\n')}\n`;
}

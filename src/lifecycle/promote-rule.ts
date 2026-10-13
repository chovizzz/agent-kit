/**
 * 晋升(T1 `proposed→advisory` / T2 `advisory→active`,`promote --rule <id> --to ...`,设计稿 §3.1 的 1–7 步 / §3.2 / §3.3)。
 *
 * 本库只**读**(read-fs + 只读 git plumbing)与计算,不写盘;写盘由命令层经 safe-fs 完成。纯本地、零网络、不 import 后端。
 *
 * 步骤:
 *  1. 在 HEAD 树里按 id 找 `rules/<layer>/<id>.md`;personal / org / project 层一律退出 2(稳定码,P1 没有消费者 / 无提案出身);
 *  2. 工作树文件必须与 HEAD 同路径 blob 逐字节相同(补丁以 HEAD 为基线),否则 `PROMOTE_WORKTREE_DIRTY`;
 *  3. 找 `origin=proposal/<pid>` 对应的 HEAD 里的 `proposals/<pid>.yaml`;
 *  4. 方向必须在 `ALLOWED_TRANSITIONS['kit:promotion']`;已是目标状态 → `already`(幂等,退出 0);
 *  5. 生成新文本(只改 `status:`,T2 再改 `review_by:`)与补丁;
 *  6. **在内存里构造 head 视图**(叠加新文本的 GuardGit)并调用**真 `checkG3`**(`lifecycleCriteria`),再补跑 C1/C1b/C3(治理版)/C5/C6/C7/C8;
 *     任一红 → 不产出(红则不写);
 *  7. 对 base / head 两份原子集各跑一次合并 + 渲染,算 `out/` 进出清单与预算(`out-diff.ts`)。
 *
 * T2 的 `review_by` 新值:`min(今天 + (volatile?30:90) 天, created + (volatile?30:180) 天)`——前者是反思器的复审周期(`reflect/merge.ts`),
 * 后者是 lint 的上限(`atoms/lint.ts`,`review_by` 不得晚于 created+180d / volatile created+30d)。算出来不晚于今天 → `REVIEW_BY_UNREACHABLE`。
 * L2 判据对 `review_by` 没有要求(G3 只要求它随 status 转移一起改),所以上限以 lint 为准。
 */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { addDays } from '../atoms/dates.js';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { MAX_REVIEW_DAYS, MAX_VOLATILE_REVIEW_DAYS } from '../atoms/lint.js';
import { fileStem, parseAtom } from '../atoms/parse.js';
import { KitConfigSchema } from '../contracts/config.js';
import type { KitConfig } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { ProposalSchema } from '../contracts/proposal.js';
import type { Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { lifecycleCriteria } from '../guards/criteria.js';
import { checkG3 } from '../guards/g3.js';
import { ALLOWED_TRANSITIONS } from '../guards/labels.js';
import type { AtomChange, Change, GuardGit } from '../guards/types.js';
import { viewAtom } from '../guards/view.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readText } from '../io/read-fs.js';
import * as path from 'node:path';
import { REVIEW_DAYS_STABLE, REVIEW_DAYS_VOLATILE } from '../reflect/merge.js';
import type { DedupeTarget } from '../reflect/dedupe.js';
import { gitBlobOid } from '../reflect/stage.js';
import { runChecks } from './checks.js';
import { computeOutDiff, OutDiffError } from './out-diff.js';
import type { AtomSource, OutDiff } from './out-diff.js';
import { buildModifyPatch, PatchError, rewriteFrontmatter } from './patch.js';

export type PromoteTag = 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED';

/** 命令退出的原因;`reason` 是稳定码,`codes` 是(可选的)逐条失败原因码,二者都不含任何文本内容。 */
export class PromoteError extends Error {
  constructor(
    readonly code: number,
    readonly tag: PromoteTag,
    readonly reason: string,
    readonly codes: readonly string[] = [],
  ) {
    super(reason);
  }
}

export const PROMOTE_HINT_SIGNATURE =
  'add_signature_via_content_pr_then_rerun_judge_then_open_promotion_pr';

export type PromoteTarget = 'advisory' | 'active';

export interface PromoteRuleInput {
  ruleId: string;
  to: PromoteTarget;
  /** YYYY-MM-DD,已校验 */
  today: string;
  git: GuardGit;
  redactor: Pick<Redactor, 'pass2'>;
}

export type PromotionPlan =
  | { already: true; ruleId: string; status: string }
  | {
      already: false;
      promoId: string;
      ruleId: string;
      rulePath: string;
      from: string;
      to: PromoteTarget;
      /** T2 且值有变化时的新 review_by;否则 null */
      reviewBy: string | null;
      headBlobOid: string;
      ruleSha256: string;
      patch: string;
      patchSha256: string;
      attestHashes: string[];
      /** 通过的检查码(C1… 与 G3) */
      passed: string[];
      /** G3 的 warn 诊断码 → 计数 */
      warnings: Record<string, number>;
      outDiff: OutDiff;
      prBody: string;
      report: string;
    };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const PROPOSAL_ORIGIN_RE = /^proposal\/(\d{4}-\d{2}-\d{2}-\d{3})$/;
const RULE_PATH_RE = /^rules\/([^/]+)\/([^/]+)\.md$/;

/** 与 adopt.ts 同口径:judge_attempts 全是冷却 / 同厂商 / 未配置且至少一个冷却 → 本机无法核对(退出 4)。 */
function pendingIsCooldown(p: Proposal): boolean {
  const hops = p.judge_attempts;
  if (hops === undefined) return false;
  let cooldown = false;
  for (const h of hops) {
    if (h.result === 'skipped:cooldown') cooldown = true;
    else if (
      h.result !== 'skipped:same-vendor' &&
      h.result !== 'error:vendor_unknown' &&
      h.result !== 'error:not_configured'
    ) {
      return false;
    }
  }
  return cooldown;
}

/** 虚拟头部提交的 oid:只存在于内存里,所有 git 查询映射回真实 HEAD,再叠加新文本。 */
export const SYNTH_HEAD = 'f'.repeat(40);

/** 叠加层 GuardGit:head 侧读到的是「HEAD + 补丁」,基线侧仍是真实 HEAD。 */
export function overlayGit(
  real: GuardGit,
  headOid: string,
  files: ReadonlyMap<string, string>,
): GuardGit {
  const m = (o: string): string => (o === SYNTH_HEAD ? headOid : o);
  return {
    resolveCommit: (r) => real.resolveCommit(r),
    changes: () => {
      throw new Error('overlayGit: changes() 不支持');
    },
    blobText: (oid) => real.blobText(oid),
    textAt: (c, p) => (c === SYNTH_HEAD && files.has(p) ? files.get(p) : real.textAt(m(c), p)),
    stableTagCommits: () => real.stableTagCommits(),
    isAncestor: (a, d) => real.isAncestor(m(a), m(d)),
    listFiles: (c, dir) => {
      const base = real.listFiles(m(c), dir);
      if (c !== SYNTH_HEAD) return base;
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const extra = [...files.keys()].filter((p) => p.startsWith(prefix) && !base.includes(p));
      return [...base, ...extra].sort(sortStr);
    },
    fileHistory: (c, p) => real.fileHistory(m(c), p),
  };
}

/** T2 的 review_by 新值(见文件头)。 */
export function nextReviewBy(created: string, volatility: string, today: string): string {
  const volatile = volatility === 'volatile';
  const cycle = addDays(today, volatile ? REVIEW_DAYS_VOLATILE : REVIEW_DAYS_STABLE);
  const limit = addDays(created, volatile ? MAX_VOLATILE_REVIEW_DAYS : MAX_REVIEW_DAYS);
  return cycle < limit ? cycle : limit;
}

/** 工作树文件必须是普通文件(非符号链接 / 硬链接)且与 HEAD blob 逐字节相同。 */
export async function worktreeMatches(
  io: IoContext,
  rulePath: string,
  headText: string,
): Promise<boolean> {
  const abs = path.join(io.repoRoot, rulePath);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return false;
    return (await readText(abs)) === headText;
  } catch {
    return false;
  }
}

function toTarget(a: {
  fm: { id: string; status: string; signature?: { type: string; pattern?: string } | undefined };
  body: { do: string; why: string };
}): DedupeTarget {
  return {
    id: a.fm.id,
    do: a.body.do,
    why: a.body.why,
    status: a.fm.status,
    signature:
      a.fm.signature === undefined
        ? undefined
        : { type: a.fm.signature.type, pattern: a.fm.signature.pattern },
  };
}

export function loadConfig(git: GuardGit, headOid: string): KitConfig {
  const text = git.textAt(headOid, 'kit.toml');
  if (text === undefined)
    throw new PromoteError(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'CONFIG_UNREADABLE');
  try {
    const res = KitConfigSchema.safeParse(parseToml(text));
    if (res.success) return res.data;
  } catch {
    /* 落到下面统一报 */
  }
  throw new PromoteError(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'CONFIG_UNREADABLE');
}

export async function planPromotion(
  io: IoContext,
  input: PromoteRuleInput,
): Promise<PromotionPlan> {
  const { git, ruleId, to } = input;
  const fail = (code: number, tag: PromoteTag, reason: string, codes: string[] = []): never => {
    throw new PromoteError(code, tag, reason, codes);
  };
  const headOid = git.resolveCommit('HEAD');
  if (headOid === undefined) return fail(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'HEAD_UNRESOLVED');

  // 1. 找规则
  const allRulePaths = git.listFiles(headOid, 'rules').filter((p) => RULE_PATH_RE.test(p));
  const hits = allRulePaths.filter((p) => fileStem(p) === ruleId);
  if (hits.length === 0) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'RULE_NOT_FOUND');
  if (hits.length > 1) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'RULE_AMBIGUOUS');
  const rulePath = hits[0] as string;
  const layerDir = (RULE_PATH_RE.exec(rulePath) as RegExpExecArray)[1] as string;
  if (layerDir === 'personal') return fail(ExitCode.USAGE, 'USAGE', 'PERSONAL_LAYER_P2');
  if (layerDir === 'org') return fail(ExitCode.USAGE, 'USAGE', 'ORG_LAYER_NOT_PROMOTABLE');
  if (layerDir !== 'team') return fail(ExitCode.USAGE, 'USAGE', 'LAYER_NOT_PROMOTABLE');

  // 2. 工作树与 HEAD 一致
  const headText = git.textAt(headOid, rulePath);
  if (headText === undefined) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'RULE_NOT_FOUND');
  if (!(await worktreeMatches(io, rulePath, headText))) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PROMOTE_WORKTREE_DIRTY');
  }

  // 3. 提案
  const view = viewAtom(headText, rulePath);
  if (!view.ok) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_UNREADABLE');
  const origin = view.fm['origin'];
  const om = typeof origin === 'string' ? PROPOSAL_ORIGIN_RE.exec(origin) : null;
  if (om === null) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PROPOSAL_MISSING');
  const proposalPath = `proposals/${om[1] as string}.yaml`;
  const proposalText = git.textAt(headOid, proposalPath);
  if (proposalText === undefined)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PROPOSAL_MISSING');

  // 4. 方向 / 幂等
  const from = view.fm['status'];
  if (typeof from !== 'string')
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_UNREADABLE');
  if (from === to) return { already: true, ruleId, status: from };
  if (!ALLOWED_TRANSITIONS['kit:promotion'].some(([f, t]) => f === from && t === to)) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'DIRECTION_NOT_ALLOWED');
  }

  const parsedAtom = parseAtom(headText, rulePath);
  if (parsedAtom.atom === undefined)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_INVALID');
  const atom = parsedAtom.atom;
  const py = parseRestrictedYaml(proposalText, proposalPath, 'PROPOSAL_YAML');
  const pr = py.ok ? ProposalSchema.safeParse(py.value) : undefined;
  if (pr === undefined || !pr.success)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PROPOSAL_INVALID');
  const proposal = pr.data;

  // 5. 新文本与补丁
  const reviewByNew =
    to === 'active' ? nextReviewBy(atom.fm.created, atom.fm.volatility, input.today) : undefined;
  if (reviewByNew !== undefined && (reviewByNew <= input.today || reviewByNew < atom.fm.created)) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'REVIEW_BY_UNREACHABLE');
  }
  const reviewByChange =
    reviewByNew !== undefined && reviewByNew !== atom.fm.review_by ? reviewByNew : undefined;
  let newText: string;
  let patch: string;
  try {
    newText = rewriteFrontmatter(headText, {
      status: to,
      ...(reviewByChange !== undefined ? { reviewBy: reviewByChange } : {}),
    });
    patch = buildModifyPatch(rulePath, headText, newText);
  } catch (e) {
    if (e instanceof PatchError) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', e.code);
    throw e;
  }
  // 补丁结果仍须是合法原子;唯一例外:无 signature 的原子升 active 在 schema 层就不合法——留给 G3 报稳定码 SIGNATURE_MISSING(两步流程提示)
  const newParsed = parseAtom(newText, rulePath);
  if (newParsed.atom === undefined && !(to === 'active' && atom.fm.signature === undefined)) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PATCH_RESULT_INVALID');
  }

  // 6a. C1 / C1b / C3(治理版)/ C5 / C6 / C7 / C8(对 HEAD 原子)
  const existing: DedupeTarget[] = [];
  const existingIds = new Set<string>();
  for (const p of allRulePaths) {
    existingIds.add(fileStem(p));
    const t = git.textAt(headOid, p);
    const a = t === undefined ? undefined : parseAtom(t, p).atom;
    if (a !== undefined) existing.push(toTarget(a));
  }
  const tombstones = new Set(
    git
      .listFiles(headOid, 'lifecycle')
      .map((p) => /^lifecycle\/([^/]+)\//.exec(p)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  const agg = runChecks(
    {
      atom,
      atomText: headText,
      proposal,
      c3Mode: 'governance',
      c7: {
        mode: 'promote',
        existingIds,
        existingAtoms: existing,
        stagedIds: new Set(),
        stagedAtoms: [],
        tombstoneIds: tombstones,
      },
      redactor: input.redactor,
    },
    ['C1', 'C1b', 'C3', 'C5', 'C6', 'C7', 'C8'],
  );
  const failures: string[] = [];
  for (const f of agg.failures) for (const r of f.reasons) failures.push(`${f.code}:${r}`);

  // 6b. 真 checkG3(内存 head 视图)
  const overlay = new Map<string, string>([[rulePath, newText]]);
  const sim = overlayGit(git, headOid, overlay);
  const change: Change = {
    kind: 'M',
    path: rulePath,
    baseMode: '100644',
    headMode: '100644',
    baseOid: gitBlobOid(headText),
    headOid: gitBlobOid(newText),
  };
  const atoms: AtomChange[] = [{ change, base: view, head: viewAtom(newText, rulePath) }];
  const g3 = checkG3('kit:promotion', [change], atoms, lifecycleCriteria, {
    git: sim,
    baseOid: headOid,
    headOid: SYNTH_HEAD,
  });
  const warnings: Record<string, number> = {};
  for (const d of g3) {
    if (d.severity === 'error') failures.push(`G3:${d.code.replace(/^GUARD_G3_/, '')}`);
    else warnings[d.code] = (warnings[d.code] ?? 0) + 1;
  }
  const uniqFailures = [...new Set(failures)].sort(sortStr);
  if (uniqFailures.length > 0) {
    // 冷却挂起(只有 judge_attempts、全是冷却 / 同厂商 / 未配置):稍后重跑 judge 即可 → 退出 4
    const pendingOnly =
      proposal.judge === undefined &&
      pendingIsCooldown(proposal) &&
      uniqFailures.every(
        (c) => c === 'G3:JUDGE_PENDING' || c === 'C5:JUDGE_PENDING' || c === 'C6:JUDGE_MISSING',
      );
    if (pendingOnly)
      throw new PromoteError(ExitCode.NOT_RUN, 'NOT_RUN', 'judge_pending:cooldown', uniqFailures);
    throw new PromoteError(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'criteria_failed', uniqFailures);
  }
  const passed = ['C1', 'C1b', 'C3', 'C5', 'C6', 'C7', 'C8', 'G3'];

  // 7. out/ 进出清单 + 预算
  const baseSources: AtomSource[] = [];
  // 项目层原子(.kit/rules/**.md,lint 同样收集)也参与合并 / 渲染,否则被边压住 / 复活的项目层原子会漏出清单
  const projectPaths = git.listFiles(headOid, '.kit/rules').filter((p) => p.endsWith('.md'));
  for (const p of [...allRulePaths, ...projectPaths]) {
    baseSources.push({ path: p, text: git.textAt(headOid, p) as string });
  }
  const headSources = baseSources.map((s) =>
    s.path === rulePath ? { path: s.path, text: newText } : s,
  );
  let outDiff: OutDiff;
  try {
    outDiff = computeOutDiff({
      base: baseSources,
      head: headSources,
      config: loadConfig(git, headOid),
    });
  } catch (e) {
    if (e instanceof OutDiffError)
      return fail(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', `OUT_DIFF_${e.code}`);
    throw e;
  }
  if (outDiff.budgetBlockedByChange)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'BUDGET_BLOCKED');

  // id / 报告 / PR 描述
  const attestHashes: string[] = [];
  for (const p of git.listFiles(headOid, `attest/${ruleId}`)) {
    attestHashes.push(sha256(git.textAt(headOid, p) ?? ''));
  }
  attestHashes.sort(sortStr);
  const headBlobOid = gitBlobOid(headText);
  const ruleSha256 = proposal.judge?.rule_sha256 as string; // C6 已保证存在且等于当前哈希
  const patchSha256 = sha256(patch);
  // 哈希输入加域分隔标记(kit-promote-rule-v1)与 L3 采纳的 id 区分;再并入目标 review_by(同输入同 id,不同日期的 T2 补丁不同 id)
  const promoId = `promo-${sha256(
    [
      'kit-promote-rule-v1',
      ruleId,
      from,
      to,
      headBlobOid,
      attestHashes.join(','),
      reviewByChange ?? '',
    ].join('\0'),
  ).slice(0, 16)}`;
  const core = {
    schema_version: 1,
    kind: 'promote_rule',
    promo_id: promoId,
    rule_id: ruleId,
    rule_path: rulePath,
    from,
    to,
    review_by_new: reviewByChange ?? null,
    kit_version: KIT_VERSION,
    head_blob_oid: headBlobOid,
    rule_sha256: ruleSha256,
    patch_sha256: patchSha256,
    attest_files: attestHashes.length,
    attest_hashes: attestHashes,
    checks_passed: passed,
    warnings: Object.fromEntries(Object.entries(warnings).sort(([a], [b]) => sortStr(a, b))),
    out_diff: outDiff.channels,
  };
  const prBody = buildPrBody(core);
  const report = canonicalJson({ ...core, pr_body_sha256: sha256(prBody) });
  return {
    already: false,
    promoId,
    ruleId,
    rulePath,
    from,
    to,
    reviewBy: reviewByChange ?? null,
    headBlobOid,
    ruleSha256,
    patch,
    patchSha256,
    attestHashes,
    passed,
    warnings: core.warnings,
    outDiff,
    prBody,
    report,
  };
}

interface PrCore {
  promo_id: string;
  rule_id: string;
  rule_path: string;
  from: string;
  to: string;
  review_by_new: string | null;
  head_blob_oid: string;
  rule_sha256: string;
  patch_sha256: string;
  attest_files: number;
  attest_hashes: string[];
  checks_passed: string[];
  warnings: Record<string, number>;
  out_diff: OutDiff['channels'];
}

/** 只含 id / 状态 / 计数 / 哈希 / out 进出清单 / 固定模板文字;没有摘录、正文、提示。 */
function buildPrBody(c: PrCore): string {
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(无)' : xs.join('、'));
  const lines: string[] = [
    `# 晋升 ${c.rule_id}:${c.from} → ${c.to}(${c.promo_id})`,
    '',
    '本补丁由 `agent-kit promote --rule` 生成,PR 标签 `kit:promotion`。只改 frontmatter 的 `status:`' +
      (c.review_by_new !== null ? ' 与 `review_by:` 两行。' : ' 一行。'),
    '',
    `- 规则:${c.rule_id}(${c.rule_path})`,
    `- 转移:${c.from} → ${c.to}`,
    `- review_by 新值:${c.review_by_new ?? '不变'}`,
    `- 基线 blob oid:${c.head_blob_oid}`,
    `- 规则哈希(rule_sha256,status / review_by 已归一化):${c.rule_sha256}`,
    `- 补丁哈希(sha256):${c.patch_sha256}`,
    `- attest 文件数:${c.attest_files}`,
    ...c.attest_hashes.map((h) => `  - ${h}`),
    `- 已通过的检查:${c.checks_passed.join('、')}`,
  ];
  const warnCodes = Object.entries(c.warnings);
  if (warnCodes.length > 0) {
    lines.push(`- 提示(warn,不阻断):${warnCodes.map(([k, n]) => `${k}×${n}`).join('、')}`);
  }
  lines.push('', '## out/ 进出清单', '');
  for (const ch of c.out_diff) {
    lines.push(
      `### 渠道 ${ch.channel}`,
      '',
      `- 进入 out/ 的原子:${list(ch.atomsIn)}`,
      `- 离开 out/ 的原子:${list(ch.atomsOut)}`,
      `- 新增输出文件:${list(ch.filesAdded)}`,
      `- 删除输出文件:${list(ch.filesRemoved)}`,
      `- 内容变化的输出文件:${list(ch.filesChanged)}`,
      '',
    );
  }
  lines.push(
    '## 应用',
    '',
    '- `git apply --whitespace=error promote.patch`,然后以标签 `kit:promotion` 提 PR。',
    '- 单人模式:PR 作者与审批人可能是同一人,需远端分支保护 + CODEOWNERS 才有真四眼(P1-D 前无硬门)。',
    '- 补丁绑定 HEAD 里的 blob;HEAD 之后有人改了该规则文件,`git apply` 会因上下文不符失败,重新跑 promote 即可。',
    '',
  );
  return lines.join('\n');
}

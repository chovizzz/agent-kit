/**
 * 退役(T3 `advisory→deprecated` / T4 `active→deprecated` / T5 `deprecated→retired` / T6 `proposed→retired`,
 * `retire --rule <id> --to deprecated|retired --reason <码>`,设计稿 §1 / §4 / §5 / §6 / §7,决策 ⑦A / ⑩A)。
 *
 * 本库只**读**(read-fs + 只读 git plumbing)与计算,不写盘;写盘由命令层经 safe-fs 完成。纯本地、零网络、不 import 后端。
 *
 * 补丁 = ① 原子文件只改 `status:` 一行 + ② 新增 `lifecycle/<rule-id>/<recorded_at>-<run_id>.json`(审计记录,兼作 id 墓碑)。
 * 判据**不在本库重写**:在内存里构造 head 视图(叠加两处改动的 GuardGit)后调用真 `checkG3('kit:retire', …, lifecycleCriteria)`,
 * 六个理由码的机械证据(expired / superseded / no_exposure / harmful / rejected / manual)、deprecated→retired 的冷却(⑩A)、
 * 记录与规则哈希的一致性,全部由 L2 的同一份判据承担;红则不写。
 *
 * attest_digests 的选取(no_exposure / harmful):候选 = head 树 `attest/<id>/` 下全部文件的内容哈希;L2 判据要求「每一项都指向计入口径的有效
 * attest」,所以对每个候选单独探测一次(只引用它),被判「不指向有效 attest」的剔除,其余按字典序全部引用。聚合口径只有 L2 一份。
 *
 * 稳定码(`reason`):USAGE:PERSONAL_LAYER_P2 / ORG_LAYER_NOT_PROMOTABLE / LAYER_NOT_PROMOTABLE;
 * CHECK_FAILED:RULE_NOT_FOUND RULE_AMBIGUOUS PROMOTE_WORKTREE_DIRTY ATOM_UNREADABLE ATOM_INVALID DIRECTION_NOT_ALLOWED
 * REASON_DIRECTION_MISMATCH RULE_HASH_UNCOMPUTABLE PATCH_* BUDGET_BLOCKED,以及证据码 REASON_NOT_EXPIRED / REASON_BY_INVALID /
 * REASON_NO_EXPOSURE_UNMET / REASON_NOT_HARMFUL / COOLDOWN_NOT_MET(来自 L2 判据),其余判据红统一 `criteria_failed`;
 * NOT_RUN:NO_ATTEST_IN_WINDOW(no_exposure 但没有任何计入口径的 attest,无法判断);FAIL_CLOSED:HEAD_UNRESOLVED CONFIG_UNREADABLE OUT_DIFF_* RECORD_INVALID。
 *
 * 幂等:`run_id` 与 `retire_id` 都由输入内容决定(`run-<today>T000000Z-<输入哈希前 6 位>`),同输入同补丁同 id;
 * 墓碑记录目录名 = 规则 id,所以同一 id 退役后即使原子文件被 G4 删掉,C7 仍拒绝重用(命令层把 `lifecycle/*` 目录名传给 C7)。
 */
import { createHash } from 'node:crypto';
import { fileStem, parseAtom } from '../atoms/parse.js';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  LifecycleRecordSchema,
  lifecycleFileName,
  RETIRE_REASONS,
} from '../contracts/lifecycle.js';
import type { LifecycleRecord, RetireReason } from '../contracts/lifecycle.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { lifecycleCriteria } from '../guards/criteria.js';
import { checkG3 } from '../guards/g3.js';
import { ALLOWED_TRANSITIONS } from '../guards/labels.js';
import type { AtomChange, Change, GuardGit } from '../guards/types.js';
import { viewAtom } from '../guards/view.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { gitBlobOid } from '../reflect/stage.js';
import { RuleHashError, ruleSha256 } from './checks.js';
import { computeOutDiff, OutDiffError } from './out-diff.js';
import type { AtomSource, OutDiff } from './out-diff.js';
import { buildAddFilePatch, buildModifyPatch, PatchError, rewriteFrontmatter } from './patch.js';
import {
  loadConfig,
  overlayGit,
  PromoteError,
  SYNTH_HEAD,
  worktreeMatches,
} from './promote-rule.js';

export type RetireTag = 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED';

/** 命令退出的原因;`reason` 是稳定码,`codes` 是(可选的)逐条失败原因码,二者都不含任何文本内容。 */
export class RetireError extends Error {
  constructor(
    readonly code: number,
    readonly tag: RetireTag,
    readonly reason: string,
    readonly codes: readonly string[] = [],
  ) {
    super(reason);
  }
}

export type RetireTarget = 'deprecated' | 'retired';

export interface RetireRuleInput {
  ruleId: string;
  to: RetireTarget;
  reason: RetireReason;
  /** 仅 `superseded`:接替者 id */
  by?: string | undefined;
  /** YYYY-MM-DD,已校验;也是记录的 `recorded_at` 与 `expired` 的比较日 */
  today: string;
  git: GuardGit;
}

export type RetirePlan =
  | { already: true; ruleId: string; status: string }
  | {
      already: false;
      retireId: string;
      ruleId: string;
      rulePath: string;
      from: string;
      to: RetireTarget;
      reason: RetireReason;
      by: string | null;
      recordPath: string;
      recordSha256: string;
      headBlobOid: string;
      ruleSha256: string;
      patch: string;
      patchSha256: string;
      attestDigests: string[];
      warnings: Record<string, number>;
      outDiff: OutDiff;
      prBody: string;
      report: string;
    };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const RULE_PATH_RE = /^rules\/([^/]+)\/([^/]+)\.md$/;
const PROBE_RUN_ID = 'run-19700101T000000Z-000000';
const NO_BLOB = '0'.repeat(40);

/** 失败里值得单独作为 `reason` 暴露的证据码(L2 判据的稳定码,去掉 GUARD_G3_ 前缀)。 */
const EVIDENCE_CODES = [
  'REASON_NOT_EXPIRED',
  'REASON_BY_INVALID',
  'REASON_NO_EXPOSURE_UNMET',
  'REASON_NOT_HARMFUL',
  'COOLDOWN_NOT_MET',
] as const;

/** 理由码与方向的配对(设计稿 §4 表;与 `LifecycleRecordSchema` 的 superRefine 同口径,这里先给稳定码)。 */
function directionOk(from: string, to: string, reason: RetireReason): boolean {
  if (reason === 'rejected') return from === 'proposed' && to === 'retired';
  if (from === 'proposed') return false;
  if (reason === 'no_exposure' || reason === 'harmful') return to === 'deprecated';
  return true;
}

export function isRetireReason(x: string): x is RetireReason {
  return (RETIRE_REASONS as readonly string[]).includes(x);
}

export async function planRetirement(io: IoContext, input: RetireRuleInput): Promise<RetirePlan> {
  const { git, ruleId, to, reason, today } = input;
  const by = reason === 'superseded' ? input.by : undefined;
  const fail = (code: number, tag: RetireTag, why: string, codes: string[] = []): never => {
    throw new RetireError(code, tag, why, codes);
  };
  const headOid = git.resolveCommit('HEAD');
  if (headOid === undefined) return fail(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'HEAD_UNRESOLVED');

  // 1. 找规则 + 层
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

  // 3. 状态 / 幂等 / 方向 / 理由配对
  const view = viewAtom(headText, rulePath);
  if (!view.ok) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_UNREADABLE');
  const from = view.fm['status'];
  if (typeof from !== 'string')
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_UNREADABLE');
  if (from === to) return { already: true, ruleId, status: from };
  if (!ALLOWED_TRANSITIONS['kit:retire'].some(([f, t]) => f === from && t === to)) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'DIRECTION_NOT_ALLOWED');
  }
  if (!directionOk(from, to, reason)) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'REASON_DIRECTION_MISMATCH');
  }
  const parsedAtom = parseAtom(headText, rulePath);
  if (parsedAtom.atom === undefined)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'ATOM_INVALID');
  const owner = parsedAtom.atom.fm.owner;
  let headSha: string;
  try {
    headSha = ruleSha256(headText);
  } catch (e) {
    if (e instanceof RuleHashError)
      return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'RULE_HASH_UNCOMPUTABLE');
    throw e;
  }

  // 4. 新文本与原子补丁(只改 status 一行)
  let newText: string;
  let atomPatch: string;
  try {
    newText = rewriteFrontmatter(headText, { status: to });
    atomPatch = buildModifyPatch(rulePath, headText, newText);
  } catch (e) {
    if (e instanceof PatchError) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', e.code);
    throw e;
  }
  if (parseAtom(newText, rulePath).atom === undefined) {
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'PATCH_RESULT_INVALID');
  }
  const headBlobOid = gitBlobOid(headText);

  // 5. 记录 + 内存模拟(真 checkG3)
  const recordOf = (digests: readonly string[], runId: string): LifecycleRecord => {
    const res = LifecycleRecordSchema.safeParse({
      schema_version: 1,
      rule_id: ruleId,
      kind: 'retire',
      reason,
      from_status: from,
      to_status: to,
      ...(by !== undefined ? { by } : {}),
      rule_sha256: headSha,
      attest_digests: [...digests].sort(sortStr),
      kit_version: KIT_VERSION,
      run_id: runId,
      recorded_at: today,
      owner,
    });
    if (!res.success) return fail(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'RECORD_INVALID');
    return res.data;
  };
  const baseView = view;
  const simulate = (
    digests: readonly string[],
    runId: string,
  ): { diags: Diagnostic[]; record: LifecycleRecord; recordPath: string; recordText: string } => {
    const record = recordOf(digests, runId);
    const recordPath = `lifecycle/${ruleId}/${lifecycleFileName(record)}`;
    const recordText = canonicalJson(record);
    const sim = overlayGit(
      git,
      headOid,
      new Map([
        [rulePath, newText],
        [recordPath, recordText],
      ]),
    );
    const atomChange: Change = {
      kind: 'M',
      path: rulePath,
      baseMode: '100644',
      headMode: '100644',
      baseOid: headBlobOid,
      headOid: gitBlobOid(newText),
    };
    const recordChange: Change = {
      kind: 'A',
      path: recordPath,
      baseMode: '000000',
      headMode: '100644',
      baseOid: NO_BLOB,
      headOid: gitBlobOid(recordText),
    };
    const atoms: AtomChange[] = [
      { change: atomChange, base: baseView, head: viewAtom(newText, rulePath) },
    ];
    const diags = checkG3('kit:retire', [recordChange, atomChange], atoms, lifecycleCriteria, {
      git: sim,
      baseOid: headOid,
      headOid: SYNTH_HEAD,
    });
    return { diags, record, recordPath, recordText };
  };

  // 5a. attest_digests:只有 no_exposure / harmful 需要
  let digests: string[] = [];
  if (reason === 'no_exposure' || reason === 'harmful') {
    const candidates = new Map<string, string>(); // digest → path
    for (const p of git.listFiles(headOid, `attest/${ruleId}`)) {
      candidates.set(`sha256:${sha256(git.textAt(headOid, p) ?? '')}`, p);
    }
    for (const d of [...candidates.keys()].sort(sortStr)) {
      const probe = simulate([d], PROBE_RUN_ID).diags;
      const invalid = probe.some(
        (x) => x.code === 'GUARD_G3_RECORD_DIGESTS' && x.message.includes('每一项都指向'),
      );
      if (!invalid) digests.push(d);
    }
    digests = [...new Set(digests)].sort(sortStr);
    if (reason === 'no_exposure' && digests.length === 0) {
      return fail(ExitCode.NOT_RUN, 'NOT_RUN', 'NO_ATTEST_IN_WINDOW');
    }
  }

  // 5b. 输入哈希 → run_id / retire_id(同输入同值)
  const inputHash = sha256(
    [
      'kit-retire-rule-v1',
      ruleId,
      from,
      to,
      reason,
      by ?? '',
      headBlobOid,
      digests.join(','),
      today,
    ].join('\0'),
  );
  const runId = `run-${today.replaceAll('-', '')}T000000Z-${inputHash.slice(0, 6)}`;

  const sim = simulate(digests, runId);
  const failures: string[] = [];
  const warnings: Record<string, number> = {};
  for (const d of sim.diags) {
    if (d.severity === 'error') failures.push(`G3:${d.code.replace(/^GUARD_G3_/, '')}`);
    else warnings[d.code] = (warnings[d.code] ?? 0) + 1;
  }
  const uniqFailures = [...new Set(failures)].sort(sortStr);
  if (uniqFailures.length > 0) {
    const specific = EVIDENCE_CODES.find((c) => uniqFailures.includes(`G3:${c}`));
    throw new RetireError(
      ExitCode.CHECK_FAILED,
      'CHECK_FAILED',
      specific ?? 'criteria_failed',
      uniqFailures,
    );
  }

  // 6. 补丁 = 记录(新增文件)+ 原子(只改 status)
  let patch: string;
  try {
    patch = buildAddFilePatch(sim.recordPath, sim.recordText) + atomPatch;
  } catch (e) {
    if (e instanceof PatchError) return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', e.code);
    throw e;
  }

  // 7. out/ 进出清单 + 预算(退役声明者的边不再生效,被压住的原子会复活进 out/,体现在 atomsIn)
  const baseSources: AtomSource[] = [];
  const projectPaths = git.listFiles(headOid, '.kit/rules').filter((p) => p.endsWith('.md'));
  for (const p of [...allRulePaths, ...projectPaths]) {
    baseSources.push({ path: p, text: git.textAt(headOid, p) as string });
  }
  const headSources = baseSources.map((s) =>
    s.path === rulePath ? { path: s.path, text: newText } : s,
  );
  let outDiff: OutDiff;
  try {
    let config;
    try {
      config = loadConfig(git, headOid);
    } catch (e) {
      if (e instanceof PromoteError) return fail(e.code, e.tag, e.reason);
      throw e;
    }
    outDiff = computeOutDiff({ base: baseSources, head: headSources, config });
  } catch (e) {
    if (e instanceof OutDiffError)
      return fail(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', `OUT_DIFF_${e.code}`);
    throw e;
  }
  if (outDiff.budgetBlockedByChange)
    return fail(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'BUDGET_BLOCKED');

  // 产物 id 还要绑定 out/ 清单、warn、版本:这些随 HEAD 里其它原子 / 配置而变,目标原子不变也会让 report / pr-body 变,
  // 不绑定的话同 id 会撞上旧产物(假的 RETIRE_RUN_EXISTS)。run_id / 记录 / 补丁不受影响,仍只由目标输入决定。
  const retireId = `retire-${sha256(
    [
      inputHash,
      canonicalJson({
        out: outDiff.channels,
        warnings: Object.entries(warnings).sort(([a], [b]) => sortStr(a, b)),
        kit: KIT_VERSION,
      }),
    ].join('\0'),
  ).slice(0, 16)}`;
  const patchSha256 = sha256(patch);
  const recordSha256 = sha256(sim.recordText);
  const core = {
    schema_version: 1,
    kind: 'retire_rule',
    retire_id: retireId,
    rule_id: ruleId,
    rule_path: rulePath,
    from,
    to,
    reason,
    by: by ?? null,
    recorded_at: today,
    run_id: runId,
    kit_version: KIT_VERSION,
    head_blob_oid: headBlobOid,
    rule_sha256: headSha,
    record_path: sim.recordPath,
    record_sha256: recordSha256,
    patch_sha256: patchSha256,
    attest_digests: digests,
    checks_passed: ['G3'],
    warnings: Object.fromEntries(Object.entries(warnings).sort(([a], [b]) => sortStr(a, b))),
    out_diff: outDiff.channels,
  };
  const prBody = buildPrBody(core);
  const report = canonicalJson({ ...core, pr_body_sha256: sha256(prBody) });
  return {
    already: false,
    retireId,
    ruleId,
    rulePath,
    from,
    to,
    reason,
    by: by ?? null,
    recordPath: sim.recordPath,
    recordSha256,
    headBlobOid,
    ruleSha256: headSha,
    patch,
    patchSha256,
    attestDigests: digests,
    warnings: core.warnings,
    outDiff,
    prBody,
    report,
  };
}

interface PrCore {
  retire_id: string;
  rule_id: string;
  rule_path: string;
  from: string;
  to: string;
  reason: string;
  by: string | null;
  recorded_at: string;
  head_blob_oid: string;
  rule_sha256: string;
  record_path: string;
  record_sha256: string;
  patch_sha256: string;
  attest_digests: string[];
  checks_passed: string[];
  warnings: Record<string, number>;
  out_diff: OutDiff['channels'];
}

/** 只含 id / 状态 / 计数 / 哈希 / out 进出清单 / 固定模板文字;没有摘录、正文、提示。 */
function buildPrBody(c: PrCore): string {
  const list = (xs: readonly string[]): string => (xs.length === 0 ? '(无)' : xs.join('、'));
  const lines: string[] = [
    `# 退役 ${c.rule_id}:${c.from} → ${c.to}(${c.retire_id})`,
    '',
    '本补丁由 `agent-kit retire --rule` 生成,PR 标签 `kit:retire`。原子文件只改 frontmatter 的 `status:` 一行,并新增一条退役审计记录(只增目录 `lifecycle/<rule-id>/`,兼作 id 墓碑)。',
    '',
    `- 规则:${c.rule_id}(${c.rule_path})`,
    `- 转移:${c.from} → ${c.to}`,
    `- 理由码:${c.reason}${c.by !== null ? `(接替者 ${c.by})` : ''}`,
    `- 记录日期(recorded_at):${c.recorded_at}`,
    `- 基线 blob oid:${c.head_blob_oid}`,
    `- 规则哈希(rule_sha256,status / review_by 已归一化):${c.rule_sha256}`,
    `- 审计记录:${c.record_path}(sha256 ${c.record_sha256})`,
    `- 补丁哈希(sha256):${c.patch_sha256}`,
    `- 引用的 attest 文件数:${c.attest_digests.length}`,
    ...c.attest_digests.map((h) => `  - ${h}`),
    `- 已通过的检查:${c.checks_passed.join('、')}(真 checkG3 + L2 判据,内存模拟)`,
  ];
  const warnCodes = Object.entries(c.warnings);
  if (warnCodes.length > 0) {
    lines.push(`- 提示(warn,不阻断):${warnCodes.map(([k, n]) => `${k}×${n}`).join('、')}`);
  }
  lines.push(
    '',
    '## out/ 进出清单',
    '',
    '`deprecated` / `retired` 声明者的 `overrides` / `disables` 边不再生效:被它压住的原子会复活进 out/(下面「进入 out/ 的原子」),评审者须逐个核对。',
    '',
  );
  for (const ch of c.out_diff) {
    lines.push(
      `### 渠道 ${ch.channel}`,
      '',
      `- 进入 out/ 的原子(含被压住而复活的):${list(ch.atomsIn)}`,
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
    '- `git apply --whitespace=error retire.patch`,然后以标签 `kit:retire` 提 PR。',
    '- 单人模式:PR 作者与审批人可能是同一人,需远端分支保护 + CODEOWNERS 才有真四眼(P1-D 前无硬门)。',
    '- 补丁以 HEAD 里的 blob 为基线生成;HEAD 之后若有人改了该规则文件,请重新跑 retire(`git apply` 只看 hunk 上下文,不保证拦住远离 status 行的改动;审计记录里的 rule_sha256 会让 `check --guards --label kit:retire` 对此报红)。',
    '- 退役不可逆;恢复 = 新建新 id 的原子(`supersedes: [旧 id]`)。`lifecycle/<rule-id>/` 目录永久占住该 id。',
    '',
  );
  return lines.join('\n');
}

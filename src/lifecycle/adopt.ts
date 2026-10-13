/**
 * 采纳(T0,`promote --run`,设计稿 §3.1 / §3.2):把 reflect 暂存、judge 评审过的团队层提案,
 * 用**当前**(已含 judge 记录的)`proposals/<id>.yaml` + `rules/team/<id>.md` 重新生成补丁 `promote.patch`。
 * 修缺口 G-a:暂存区里的 `apply.patch` 在 judge 之后是陈旧的(提案里没有 judge 记录),晋升时会被机械拒绝。
 *
 * - 本库只**读**(read-fs)与计算,不写盘;写盘由命令层经 safe-fs 完成。纯本地、零网络(不 import llm-exec / backends)。
 * - 不改暂存区里的任何文件(旧 `apply.patch` 原样留着,PR 描述写明作废)。
 * - 每条提案跑 C1–C9(`runChecks`,C3 取严格版,C6 即「judge 记录的 rule_sha256 == 暂存规则文件当前哈希」);
 *   单条不过只丢该条并按原因码计数;fail-closed 条件(状态损坏、信号库损坏、脱敏扫描异常、文件系统类型异常、
 *   检查自身异常)整批抛 `AdoptFailClosedError`,不产出任何东西。
 * - personal 层一律拒(`PERSONAL_LAYER_P2`,P1 没有消费者)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseAtom } from '../atoms/parse.js';
import { AGENT_IDS } from '../contracts/common.js';
import { SignalSchema } from '../contracts/signal.js';
import { KIT_VERSION } from '../contracts/meta.js';
import type { Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { checkG1 } from '../guards/g1.js';
import { checkG2 } from '../guards/g2.js';
import { checkReflectorPaths } from '../guards/path-guard.js';
import { isAtomPath } from '../guards/paths.js';
import type { AtomChange, Change } from '../guards/types.js';
import { viewAtom } from '../guards/view.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { exists, lstat, readDir, readLines, readText, TOO_LONG_LINE } from '../io/read-fs.js';
import { loadRun, runDir } from '../judge/store.js';
import type { LoadedProposal } from '../judge/store.js';
import { loadExistingAtoms } from '../reflect/atoms-index.js';
import type { DedupeTarget } from '../reflect/dedupe.js';
import { buildApplyPatch, gitBlobOid } from '../reflect/stage.js';
import { hasInvisible } from '../reflect/text.js';
import { scanDangerousPhrases } from '../reflect/validate.js';
import { SignalStoreError } from '../signals/state-store.js';
import { findInvisibleRanges } from './invisible.js';
import { runChecks } from './checks.js';
import type { FsFact, SignalFact, SignalLookup } from './checks.js';

/** 整批 fail-closed(命令退出 3)。`code` 是稳定码,不含任何文本内容。 */
export class AdoptFailClosedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const PERSONAL_REASON = 'PERSONAL_LAYER_P2';

export interface AdoptInput {
  runId: string;
  redactor: Pick<Redactor, 'pass2'>;
  /** `reflect.team_project_keys` 白名单;缺省/空 = 全部 personal */
  teamProjectKeys: readonly string[];
  vendorOverrides?: Readonly<Record<string, string>>;
}

export interface AdoptedItem {
  proposalId: string;
  ruleId: string;
  ruleSha256: string;
  proposalSha256: string;
  atomSha256: string;
  proposalPath: string;
  atomPath: string;
}

export interface DroppedItem {
  proposalId: string;
  /** 原因码,`<检查码>:<原因>`(C1:DANGEROUS_PHRASE)或 `PERSONAL_LAYER_P2`;去重、已排序 */
  reasons: string[];
  /** 只因「本机无法核对」被丢(调用方映射为退出 4) */
  unverifiable: boolean;
  personal: boolean;
}

export interface AdoptPlan {
  runId: string;
  promoId: string;
  total: number;
  adopted: AdoptedItem[];
  dropped: DroppedItem[];
  /** 原因码 → 被它丢掉的提案数(键已排序) */
  droppedByReason: Record<string, number>;
  /** 要进补丁的文件(仓库相对路径 + 内容);无采纳项时为空 */
  files: { path: string; content: string }[];
  patch: string;
  patchSha256: string;
  prBody: string;
  report: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Kind = FsFact['kind'];

async function factOf(label: string, p: string, expect: 'file' | 'dir'): Promise<{ fact: FsFact }> {
  const st = await lstat(p);
  const kind: Kind = st.isSymbolicLink()
    ? 'symlink'
    : st.isDirectory()
      ? 'dir'
      : st.isFile()
        ? 'file'
        : 'other';
  return { fact: { path: label, kind, expect, nlink: st.nlink } };
}

// ---------------------------------------------------------------- 信号库(C2 / C4 的本机事实)

interface FactsIndex {
  lookup: SignalLookup;
  sessionRefOf: (sig: string) => string | undefined;
}

const CONFLICT = Symbol('conflict');

/**
 * 只读扫 `.state/signals/<agent>/*.jsonl`,收集 `needed` 里的 sig_id。非 JSON / 超长行 → SignalStoreError(整批 fail-closed)。
 * 同一 sig_id 出现两次且内容不同 → 查询时抛错(C2 记 SIGNAL_LOOKUP_ERROR,整批 fail-closed)。
 */
export async function loadSignalFacts(
  io: IoContext,
  needed: ReadonlySet<string>,
): Promise<FactsIndex> {
  const found = new Map<string, SignalFact | typeof CONFLICT>();
  const root = path.join(io.stateDir, 'signals');
  if (needed.size > 0 && (await exists(root))) {
    // 输入目录里的符号链接不是「查不到」而是状态异常:整批 fail-closed(退出 3)
    if ((await lstat(root)).isSymbolicLink()) throw new SignalStoreError('信号库根目录是符号链接');
    for (const a of await readDir(root)) {
      if (!(AGENT_IDS as readonly string[]).includes(a.name)) continue;
      if (a.isSymbolicLink || !a.isDirectory) throw new SignalStoreError('信号库 agent 目录异常');
      const dir = path.join(root, a.name);
      for (const f of await readDir(dir)) {
        if (!/^\d{6}\.jsonl$/.test(f.name)) continue;
        if (f.isSymbolicLink || !f.isFile) throw new SignalStoreError('信号库月份文件异常');
        for await (const line of readLines(path.join(dir, f.name), 64 * 1024)) {
          if (line === '') continue;
          if (line === TOO_LONG_LINE) throw new SignalStoreError('信号库含超长行');
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            throw new SignalStoreError('信号库含无法解析的行');
          }
          const o = raw as Record<string, unknown> | null;
          const id = o?.['sig_id'];
          if (typeof id !== 'string' || !needed.has(id)) continue;
          // 需要的那几条按信号契约完整校验;不合 schema 当作库带病(查询时抛错 → 整批 fail-closed)
          const sp = SignalSchema.safeParse(raw);
          if (!sp.success) {
            found.set(id, CONFLICT);
            continue;
          }
          const pk = sp.data.project_key;
          const ex = sp.data.excerpt_redacted;
          const sr = sp.data.session_ref;
          const fact: SignalFact = {
            sig_id: id,
            project_key: pk,
            excerpt_redacted: ex,
            session_ref: sr,
          };
          const prev = found.get(id);
          if (prev === undefined) found.set(id, fact);
          else if (
            prev === CONFLICT ||
            prev.project_key !== pk ||
            prev.excerpt_redacted !== ex ||
            prev.session_ref !== sr
          ) {
            found.set(id, CONFLICT);
          }
        }
      }
    }
  }
  const get = (sig: string): SignalFact | undefined => {
    const v = found.get(sig);
    if (v === CONFLICT) throw new SignalStoreError('同一 sig_id 的信号内容不一致');
    return v;
  };
  return { lookup: get, sessionRefOf: (sig) => get(sig)?.session_ref };
}

// ---------------------------------------------------------------- 仓库 / 暂存区索引

/** 仓库 `rules/<dir>/*.md` 的文件名 stem(解析失败的文件也要在内)。 */
async function listRepoRuleIds(io: IoContext): Promise<Set<string>> {
  const ids = new Set<string>();
  const root = path.join(io.repoRoot, 'rules');
  if (!(await exists(root))) return ids;
  for (const d of await readDir(root)) {
    if (!d.isDirectory || d.name.startsWith('.')) continue;
    for (const f of await readDir(path.join(root, d.name))) {
      if (f.isFile && f.name.endsWith('.md')) ids.add(f.name.slice(0, -3));
    }
  }
  return ids;
}

/** 仓库 `proposals/*.yaml` 的文件名:补丁要新增 `proposals/<id>.yaml`,已存在就 `git apply` 不上。 */
async function listRepoProposalFiles(io: IoContext): Promise<Set<string>> {
  const names = new Set<string>();
  const root = path.join(io.repoRoot, 'proposals');
  if (!(await exists(root))) return names;
  for (const f of await readDir(root)) names.add(f.name);
  return names;
}

/** 墓碑:`lifecycle/<rule-id>/` 的目录名(退役记录目录兼作 id 墓碑)。 */
async function listTombstones(io: IoContext): Promise<Set<string>> {
  const ids = new Set<string>();
  const root = path.join(io.repoRoot, 'lifecycle');
  if (!(await exists(root))) return ids;
  for (const d of await readDir(root)) if (d.isDirectory) ids.add(d.name);
  return ids;
}

function toTarget(a: {
  id: string;
  do: string;
  why: string;
  status: string;
  signatureType: string | undefined;
  signaturePattern: string | undefined;
}): DedupeTarget {
  return {
    id: a.id,
    do: a.do,
    why: a.why,
    status: a.status,
    signature:
      a.signatureType === undefined
        ? undefined
        : { type: a.signatureType, pattern: a.signaturePattern },
  };
}

/**
 * **其它**暂存运行(`.state/reflect/*`,不含本次 run)里的原子:id 与去重内容。
 * (`atoms-index.loadStagedAtoms` 含本次 run,直接用会让每个提案都撞上自己的 id。)
 * 与它同口径的有效运行判定:目录、非点开头、非 `cwd`、已写出 report.json。
 */
async function loadOtherStaged(
  io: IoContext,
  runId: string,
): Promise<{ ids: Set<string>; atoms: DedupeTarget[] }> {
  const ids = new Set<string>();
  const atoms: DedupeTarget[] = [];
  const root = path.join(io.stateDir, 'reflect');
  if (!(await exists(root))) return { ids, atoms };
  for (const run of await readDir(root)) {
    if (!run.isDirectory || run.name.startsWith('.') || run.name.toLowerCase() === 'cwd') continue;
    if (run.name === runId) continue;
    if (!(await exists(path.join(root, run.name, 'report.json')))) continue;
    const rules = path.join(root, run.name, 'rules');
    if (!(await exists(rules))) continue;
    for (const d of await readDir(rules)) {
      if (!d.isDirectory) continue;
      for (const f of await readDir(path.join(rules, d.name))) {
        if (!f.isFile || !f.name.endsWith('.md')) continue;
        ids.add(f.name.slice(0, -3));
        const res = parseAtom(
          await readText(path.join(rules, d.name, f.name)),
          `rules/${d.name}/${f.name}`,
        );
        if (res.atom === undefined) continue;
        const { fm, body } = res.atom;
        atoms.push({
          id: fm.id,
          do: body.do,
          why: body.why,
          status: fm.status,
          signature:
            fm.signature === undefined
              ? undefined
              : { type: fm.signature.type, pattern: fm.signature.pattern },
        });
      }
    }
  }
  return { ids, atoms };
}

// ---------------------------------------------------------------- 判定

/** judge_attempts 的挂起原因是不是「冷却」(与 judge 的 pendingReason 同口径):是 → 退出 4,否则按硬失败。 */
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

/** 这些原因说明状态/环境坏了(而不是这一条提案不合格):整批 fail-closed。 */
const FAIL_CLOSED_REASONS = new Set([
  'REDACTION_SCAN_ERROR',
  'SIGNAL_LOOKUP_ERROR',
  'CHECK_INTERNAL_ERROR',
  'FS_SYMLINK',
  'FS_NOT_REGULAR',
  'FS_HARDLINK',
  'RUN_ID_INVALID',
  'INPUT_MISSING',
]);

/** 输入目录的祖先也不得是符号链接(`loadRun` 只管 run 目录及其以下)。不存在放过。 */
async function assertNotSymlink(p: string): Promise<void> {
  if (!(await exists(p))) return;
  if ((await lstat(p)).isSymbolicLink()) throw new AdoptFailClosedError('STATE_DIR_UNSAFE');
}

function pathsOf(p: Proposal): { proposalPath: string; atomPath: string } {
  return {
    proposalPath: `proposals/${p.id}.yaml`,
    atomPath: `rules/${p.layer}/${p.targets[0] as string}.md`,
  };
}

export async function planAdoption(io: IoContext, input: AdoptInput): Promise<AdoptPlan> {
  await assertNotSymlink(path.join(io.stateDir, 'reflect'));
  const loaded: LoadedProposal[] = await loadRun(io, input.runId); // 状态损坏 → JudgeStateError(命令层映射 3)
  const dir = runDir(io, input.runId);

  const needed = new Set<string>();
  for (const l of loaded)
    if (l.proposal.layer === 'team') for (const e of l.proposal.evidence) needed.add(e.sig);
  const facts = await loadSignalFacts(io, needed);

  const repoIds = await listRepoRuleIds(io);
  const existingAtoms = (await loadExistingAtoms(io)).map(toTarget);
  const tombstones = await listTombstones(io);
  const repoProposals = await listRepoProposalFiles(io);
  const other = await loadOtherStaged(io, input.runId);

  const adopted: AdoptedItem[] = [];
  const dropped: DroppedItem[] = [];
  const files: { path: string; content: string }[] = [];
  const earlier: DedupeTarget[] = [];

  for (const l of loaded) {
    const p = l.proposal;
    const target = p.targets[0] as string;
    const { proposalPath, atomPath } = pathsOf(p);
    const stagedRulePath = path.join(dir, 'rules', p.layer, `${target}.md`);

    // 读规则文件原文(loadRun 已确认是普通文件;这里再取 lstat 事实交给 C9,并用同一份原文做 C6 / 补丁)
    const facts9: FsFact[] = [
      (await factOf('run', dir, 'dir')).fact,
      (await factOf(`proposals/${p.id}.yaml`, l.file, 'file')).fact,
      (await factOf(atomPath, stagedRulePath, 'file')).fact,
    ];
    const atomText = await readText(stagedRulePath);
    const parsed = parseAtom(atomText, atomPath);

    const drop = (reasons: string[], unverifiable = false, personal = false): void => {
      dropped.push({
        proposalId: p.id,
        reasons: [...new Set(reasons)].sort(sortStr),
        unverifiable,
        personal,
      });
    };
    const rememberEarlier = (): void => {
      if (parsed.atom !== undefined) {
        earlier.push({
          id: parsed.atom.fm.id,
          do: parsed.atom.body.do,
          why: parsed.atom.body.why,
          status: parsed.atom.fm.status,
          signature:
            parsed.atom.fm.signature === undefined
              ? undefined
              : { type: parsed.atom.fm.signature.type, pattern: parsed.atom.fm.signature.pattern },
        });
      }
    };

    if (p.layer === 'personal') {
      drop([PERSONAL_REASON], false, true);
      rememberEarlier();
      continue;
    }
    if (parsed.atom === undefined) {
      drop(['ATOM_UNPARSABLE']);
      continue;
    }
    const atom = parsed.atom;

    const agg = runChecks({
      atom,
      atomText,
      proposal: p,
      c3Mode: 'strict',
      signalLookup: facts.lookup,
      teamProjectKeys: input.teamProjectKeys,
      sessionRefOf: facts.sessionRefOf,
      ...(input.vendorOverrides !== undefined ? { vendorOverrides: input.vendorOverrides } : {}),
      c7: {
        mode: 'adopt',
        existingIds: repoIds,
        existingAtoms,
        stagedIds: other.ids,
        stagedAtoms: [...other.atoms, ...earlier],
        tombstoneIds: tombstones,
      },
      redactor: input.redactor,
      c9: {
        runId: input.runId,
        files: [
          { path: proposalPath, content: l.text },
          { path: atomPath, content: atomText },
        ],
        fsFacts: facts9,
      },
    });
    rememberEarlier();

    // 补丁里的原文(不是解析后的对象)也要过一遍:YAML / frontmatter 注释不在 C1–C8 的字段扫描范围内
    const rawReasons: string[] = [];
    for (const t of [l.text, atomText]) rawReasons.push(...rawTextReasons(t, input.redactor));
    if (repoProposals.has(`${p.id}.yaml`)) rawReasons.push('PROPOSAL_PATH_EXISTS');

    if (!agg.ok || rawReasons.length > 0) {
      const codes: string[] = rawReasons.map((r) => `RAW:${r}`);
      for (const f of agg.failures) {
        for (const r of f.reasons) {
          if (FAIL_CLOSED_REASONS.has(r)) throw new AdoptFailClosedError(r);
          codes.push(`${f.code}:${r}`);
        }
      }
      // 冷却挂起:提案没有 judge、只有 judge_attempts(全是冷却/同厂商/未配置)。C5 报 JUDGE_PENDING,
      // 配套的 C6 必然报 JUDGE_MISSING——后者不是独立的硬失败。
      const cooldown = p.judge === undefined && pendingIsCooldown(p);
      const unverifiable =
        rawReasons.length === 0 &&
        agg.failures.length > 0 &&
        agg.failures.every(
          (f) =>
            f.unverifiable === true ||
            (cooldown &&
              ((f.code === 'C5' && f.reasons.every((r) => r === 'JUDGE_PENDING')) ||
                (f.code === 'C6' && f.reasons.every((r) => r === 'JUDGE_MISSING')))),
        );
      drop(codes, unverifiable);
      continue;
    }

    adopted.push({
      proposalId: p.id,
      ruleId: atom.fm.id,
      ruleSha256: p.judge?.rule_sha256 as string, // C6 已保证存在且等于当前哈希
      proposalSha256: sha256(l.text),
      atomSha256: sha256(atomText),
      proposalPath,
      atomPath,
    });
    files.push({ path: proposalPath, content: l.text }, { path: atomPath, content: atomText });
  }

  selfCheck(files);

  const droppedByReason: Record<string, number> = {};
  for (const d of dropped)
    for (const r of d.reasons) droppedByReason[r] = (droppedByReason[r] ?? 0) + 1;
  const sortedReasons = Object.fromEntries(
    Object.entries(droppedByReason).sort(([a], [b]) => sortStr(a, b)),
  );

  const patch = files.length > 0 ? buildApplyPatch(files) : '';
  const patchSha256 = sha256(patch);
  adopted.sort((a, b) => sortStr(a.proposalId, b.proposalId));

  const core = {
    schema_version: 1,
    kind: 'adopt',
    run_id: input.runId,
    kit_version: KIT_VERSION,
    proposals_total: loaded.length,
    adopted_count: adopted.length,
    dropped_count: dropped.length,
    adopted: adopted.map((a) => ({
      proposal_id: a.proposalId,
      rule_id: a.ruleId,
      rule_sha256: a.ruleSha256,
      proposal_sha256: a.proposalSha256,
      atom_sha256: a.atomSha256,
    })),
    dropped: dropped.map((d) => ({ proposal_id: d.proposalId, reasons: d.reasons })),
    dropped_by_reason: sortedReasons,
    patch_sha256: patchSha256,
  };
  const promoId = `promo-${sha256(canonicalJson(core)).slice(0, 16)}`;
  const prBody = buildPrBody(promoId, core);
  const report = canonicalJson({
    ...core,
    promo_id: promoId,
    pr_body_sha256: sha256(prBody),
  });
  return {
    runId: input.runId,
    promoId,
    total: loaded.length,
    adopted,
    dropped,
    droppedByReason: sortedReasons,
    files,
    patch,
    patchSha256,
    prBody,
    report,
  };
}

/**
 * 补丁原文的复扫:脱敏(pass2)、不可见字符、危险话术。抛异常按 fail-closed(整批),
 * 与 `stage.ts` / C8 同取向。返回稳定原因码(不含被扫描文本)。
 */
function rawTextReasons(text: string, redactor: Pick<Redactor, 'pass2'>): string[] {
  const out: string[] = [];
  let clean = false;
  try {
    clean = redactor.pass2(text).clean === true;
  } catch {
    throw new AdoptFailClosedError('REDACTION_SCAN_ERROR');
  }
  if (!clean) out.push('REDACTION_RESIDUAL');
  if (hasInvisible(text) || findInvisibleRanges(text).length > 0) out.push('HIDDEN_CHARS');
  if (scanDangerousPhrases(text).blocked.length > 0) out.push('DANGEROUS_PHRASE');
  return out;
}

/** 与 reflect 的「先模拟守卫」同构:补丁里的文件过 kit:reflector 的路径守卫 + G1 + G2;红 → 整批 fail-closed。 */
function selfCheck(files: readonly { path: string; content: string }[]): void {
  if (files.length === 0) return;
  const changes: Change[] = files.map((f) => ({
    kind: 'A',
    path: f.path,
    baseMode: '000000',
    headMode: '100644',
    baseOid: '0'.repeat(40),
    headOid: gitBlobOid(f.content),
  }));
  const atoms: AtomChange[] = changes
    .filter((c) => isAtomPath(c.path))
    .map((c) => ({
      change: c,
      base: undefined,
      head: viewAtom((files.find((f) => f.path === c.path) as { content: string }).content, c.path),
    }));
  const diags = [...checkReflectorPaths(changes), ...checkG1(atoms), ...checkG2(atoms)];
  if (diags.some((d) => d.severity === 'error')) throw new AdoptFailClosedError('PATCH_SELF_CHECK');
}

interface PrCore {
  run_id: string;
  proposals_total: number;
  adopted_count: number;
  dropped_count: number;
  adopted: { proposal_id: string; rule_id: string; rule_sha256: string }[];
  dropped_by_reason: Record<string, number>;
  patch_sha256: string;
}

/** 只含 id / 状态 / 计数 / 哈希 / 固定模板文字;没有摘录、正文、提示。 */
function buildPrBody(promoId: string, c: PrCore): string {
  const lines: string[] = [
    `# 采纳反思器提案(${promoId})`,
    '',
    '本补丁由 `agent-kit promote --run` 生成。**以本补丁(promote.patch)为准;暂存区里的旧 apply.patch 作废**',
    '(它不含 judge 评审记录,按晋升判据会被机械拒绝)。',
    '',
    `- run_id:${c.run_id}`,
    `- 提案总数:${c.proposals_total};采纳:${c.adopted_count};丢弃:${c.dropped_count}`,
    `- 补丁哈希(sha256):${c.patch_sha256}`,
    '- 目标状态:proposed(入库后仍须 `kit:promotion` PR 才能进 advisory / active)',
    '- 应用:`git apply --whitespace=error promote.patch`,然后按 `kit:reflector` 提内容 PR',
    '',
    '## 采纳项',
    '',
  ];
  if (c.adopted.length === 0) lines.push('(无)');
  for (const a of c.adopted) {
    lines.push(`- 提案 ${a.proposal_id} → 规则 ${a.rule_id}(rule_sha256 ${a.rule_sha256})`);
  }
  lines.push('', '## 丢弃原因计数', '');
  const reasons = Object.entries(c.dropped_by_reason);
  if (reasons.length === 0) lines.push('(无)');
  for (const [r, n] of reasons) lines.push(`- ${r}:${n}`);
  lines.push('');
  return lines.join('\n');
}

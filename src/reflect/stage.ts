/**
 * 暂存:先在内存里模拟守卫与 lint,全绿才写 `.state/reflect/<run_id>/`;任何红灯整批不暂存。
 * 只写 `.state/`(safe-fs 的写入根),从不碰 `rules/`、`proposals/` 或任何已有文件。
 * 不落盘提示原文;report.json 只含计数与哈希。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseAtom } from '../atoms/parse.js';
import { findModelNames } from '../atoms/model-names.js';
import { daysBetween } from '../atoms/dates.js';
import { MAX_REVIEW_DAYS, MAX_VOLATILE_REVIEW_DAYS } from '../atoms/lint.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { ProposalSchema, type Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { ReflectRunReportSchema, type ReflectRunReport } from '../contracts/reflect.js';
import { checkG1 } from '../guards/g1.js';
import { checkG2 } from '../guards/g2.js';
import { checkReflectorPaths } from '../guards/path-guard.js';
import { isAtomPath, isUnsafePath } from '../guards/paths.js';
import type { AtomChange, Change } from '../guards/types.js';
import { viewAtom } from '../guards/view.js';
import { exists } from '../io/read-fs.js';
import type { IoContext } from '../io/paths.js';
import { chmod, mkdirp, rename, writeFile } from '../io/safe-fs.js';
import type { MergedProposal } from './merge.js';
import { evidenceExcerptSuspicious } from './validate.js';
import { ReflectFailClosedError } from './types.js';
import type { BeforeWrite } from './types.js';

export interface StagedFile {
  /** 仓库相对路径 */
  path: string;
  content: string;
  /** 是否进 apply.patch(personal 层不进) */
  inPatch: boolean;
}

/** 补丁 / 提案路径白名单字符形;`lifecycle/checks.ts`(C9)引用同一对象,不要复刻。 */
export const SAFE_PATH_RE = /^[a-z0-9][a-z0-9/._-]*$/;
const ZERO_OID = '0'.repeat(40);

export function gitBlobOid(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export function filesOf(merged: readonly MergedProposal[]): StagedFile[] {
  const files: StagedFile[] = [];
  for (const m of merged) {
    const inPatch = m.layer !== 'personal';
    files.push({ path: m.proposalPath, content: m.proposalYaml, inPatch });
    files.push({ path: m.atomPath, content: m.atomText, inPatch });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function err(code: string, p: string, message: string): Diagnostic {
  return { code, severity: 'error', path: p, message };
}

export interface SimulateOptions {
  redactor: Pick<Redactor, 'pass2'>;
  atomMaxBytes: number;
  existingAtomIds: ReadonlySet<string>;
}

/** 内存里模拟 kit:reflector 的 diff:路径守卫 + G1 + G2 + 原子 lint 的要点 + ProposalSchema + 补丁可安全生成。 */
export function simulateGuards(
  merged: readonly MergedProposal[],
  files: readonly StagedFile[],
  opts: SimulateOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const changes: Change[] = files.map((f) => ({
    kind: 'A',
    path: f.path,
    baseMode: '000000',
    headMode: '100644',
    baseOid: ZERO_OID,
    headOid: gitBlobOid(f.content),
  }));
  for (const c of changes) {
    if (isUnsafePath(c.path) || !SAFE_PATH_RE.test(c.path)) {
      out.push(err('GUARD_PATH_UNSAFE', c.path, '路径含不允许的字符'));
    }
  }
  out.push(...checkReflectorPaths(changes));
  const atoms: AtomChange[] = changes
    .filter((c) => isAtomPath(c.path))
    .map((c) => {
      const f = files.find((x) => x.path === c.path) as StagedFile;
      return { change: c, base: undefined, head: viewAtom(f.content, c.path) };
    });
  out.push(...checkG1(atoms), ...checkG2(atoms));

  for (const m of merged) {
    const stem = m.atomId;
    if (opts.existingAtomIds.has(stem)) {
      out.push(err('ATOM_ID_DUPLICATE', m.atomPath, `id「${stem}」已存在`));
    }
    const parsed = parseAtom(m.atomText, m.atomPath);
    out.push(...parsed.diagnostics.filter((d) => d.severity === 'error'));
    const atom = parsed.atom;
    if (atom !== undefined) {
      const fm = atom.fm;
      if (fm.id !== stem)
        out.push(err('ATOM_ID_FILENAME_MISMATCH', m.atomPath, 'id 与文件名不一致'));
      if (fm.layer !== m.layer || !m.atomPath.startsWith(`rules/${fm.layer}/`)) {
        out.push(err('ATOM_LAYER_DIR_MISMATCH', m.atomPath, 'layer 与目录不一致'));
      }
      const gap = daysBetween(fm.created, fm.review_by);
      if (gap < 0)
        out.push(err('ATOM_REVIEW_BEFORE_CREATED', m.atomPath, 'review_by 早于 created'));
      if (fm.volatility === 'volatile' && gap > MAX_VOLATILE_REVIEW_DAYS) {
        out.push(err('ATOM_VOLATILE_REVIEW_TOO_FAR', m.atomPath, 'volatile 的 review_by 过远'));
      }
      if (gap > MAX_REVIEW_DAYS) out.push(err('ATOM_REVIEW_TOO_FAR', m.atomPath, 'review_by 过远'));
      if (atom.bodyBytes > opts.atomMaxBytes) {
        out.push(err('ATOM_BODY_TOO_LARGE', m.atomPath, `正文 ${atom.bodyBytes} 字节超过上限`));
      }
      const rest: Record<string, unknown> = { ...fm };
      delete rest['evidence'];
      for (const n of findModelNames(`${JSON.stringify(rest)}\n${JSON.stringify(atom.body)}`)) {
        out.push(err('ATOM_MODEL_NAME_IN_CORE', m.atomPath, `core 内不得出现具体模型名:${n}`));
      }
      for (const [i, ev] of fm.evidence.entries()) {
        if (evidenceExcerptSuspicious(ev.excerpt)) {
          out.push(
            err(
              'STAGE_EVIDENCE_SUSPICIOUS',
              `${m.atomPath}#/evidence/${i}`,
              '证据摘录含注入话术或不可见字符',
            ),
          );
        }
        let clean = false;
        try {
          clean = opts.redactor.pass2(ev.excerpt).clean;
        } catch {
          clean = false;
        }
        if (!clean) {
          out.push(
            err(
              'ATOM_EVIDENCE_REDACTION_RESIDUAL',
              `${m.atomPath}#/evidence/${i}`,
              '证据摘录复扫残留',
            ),
          );
        }
      }
      if (fm.status !== 'proposed')
        out.push(err('GUARD_G1_NEW_ATOM_NOT_PROPOSED', m.atomPath, 'status 不是 proposed'));
      if (fm.strength !== 'should')
        out.push(err('ATOM_STRENGTH_NOT_SHOULD', m.atomPath, 'strength 不是 should'));
    }
    const pr = ProposalSchema.safeParse(m.proposal);
    if (!pr.success) out.push(err('SCHEMA_INVALID', m.proposalPath, '提案不符合 ProposalSchema'));
    else if (pr.data.reflector.run_id.length === 0)
      out.push(err('SCHEMA_INVALID', m.proposalPath, 'run_id 为空'));
  }
  for (const f of files) {
    const bad = patchUnsafe(f.content);
    if (bad !== undefined) out.push(err('STAGE_PATCH_UNSAFE', f.path, bad));
  }
  return out;
}

/** 补丁里的行必须能被 `git apply` 原样应用:纯 LF、以换行结尾、无行尾空白(apply.whitespace=error 会拒)、非空。 */
export function patchUnsafe(content: string): string | undefined {
  if (content === '') return '文件为空';
  if (content.includes('\r')) return '含 CR';
  if (!content.endsWith('\n')) return '缺结尾换行';
  if (content.split('\n').some((l) => /[ \t]$/.test(l))) return '含行尾空白';
  return undefined;
}

/** 手工生成的 git unified diff(全部是新文件)。内容须先过 patchUnsafe。 */
export function buildApplyPatch(files: readonly { path: string; content: string }[]): string {
  const parts: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!SAFE_PATH_RE.test(f.path)) throw new RangeError(`补丁路径不安全:${f.path}`);
    const bad = patchUnsafe(f.content);
    if (bad !== undefined) throw new RangeError(`补丁内容不安全(${f.path}):${bad}`);
    const lines = f.content.slice(0, -1).split('\n');
    parts.push(
      `diff --git a/${f.path} b/${f.path}\n` +
        `new file mode 100644\n` +
        `index ${ZERO_OID.slice(0, 12)}..${gitBlobOid(f.content).slice(0, 12)}\n` +
        `--- /dev/null\n` +
        `+++ b/${f.path}\n` +
        `@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((l) => `+${l}`).join('\n') +
        '\n',
    );
  }
  return parts.join('');
}

export function stageDir(io: IoContext, runId: string): string {
  return path.join(io.stateDir, 'reflect', runId);
}

/** 每个实际写出口(mkdirp / chmod / writeFile / rename)之前都先过 `beforeWrite`(缺省不传 = 行为不变) */
async function mkdir700(io: IoContext, dir: string, bw?: BeforeWrite): Promise<void> {
  await bw?.();
  await mkdirp(io, dir, 0o700);
  await bw?.();
  await chmod(io, dir, 0o700);
}

async function put(io: IoContext, file: string, content: string, bw?: BeforeWrite): Promise<void> {
  await mkdir700(io, path.dirname(file), bw);
  await bw?.();
  await writeFile(io, file, content, { mode: 0o600 });
  await bw?.();
  await chmod(io, file, 0o600);
}

/** 只写报告(失败路径)。不覆盖已存在的运行目录。 */
export async function writeReportOnly(
  io: IoContext,
  runId: string,
  report: ReflectRunReport,
  beforeWrite?: BeforeWrite,
): Promise<void> {
  ReflectRunReportSchema.parse(report);
  const dir = stageDir(io, runId);
  if (await exists(dir)) {
    throw new ReflectFailClosedError('STAGE_RUN_EXISTS', '运行目录已存在,拒绝覆盖');
  }
  // 中间目录 reflect/ 的权限也收紧
  await mkdir700(io, path.join(io.stateDir, 'reflect'), beforeWrite);
  await put(io, path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, beforeWrite);
}

export async function writeStage(
  io: IoContext,
  runId: string,
  report: ReflectRunReport,
  files: readonly StagedFile[],
  beforeWrite?: BeforeWrite,
): Promise<{ dir: string; patchFiles: number }> {
  ReflectRunReportSchema.parse(report);
  const dir = stageDir(io, runId);
  if (await exists(dir)) {
    throw new ReflectFailClosedError('STAGE_RUN_EXISTS', '运行目录已存在,拒绝覆盖');
  }
  await mkdir700(io, path.join(io.stateDir, 'reflect'), beforeWrite);
  // 先写临时目录(点开头,加载器会跳过),全部写完再整体 rename:中途失败不会留下看似有效的半成品
  const tmp = path.join(io.stateDir, 'reflect', `.tmp-${runId}`);
  if (await exists(tmp)) {
    throw new ReflectFailClosedError(
      'STAGE_TMP_EXISTS',
      '上次失败留下的临时目录仍在,请人工清理后重试',
    );
  }
  for (const f of files) await put(io, path.join(tmp, f.path), f.content, beforeWrite);
  const patchFiles = files.filter((f) => f.inPatch);
  if (patchFiles.length > 0)
    await put(io, path.join(tmp, 'apply.patch'), buildApplyPatch(patchFiles), beforeWrite);
  await put(io, path.join(tmp, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, beforeWrite);
  await beforeWrite?.();
  await rename(io, tmp, dir);
  return { dir, patchFiles: patchFiles.length };
}

export type { Proposal };

/**
 * run 目录(`.state/reflect/<run_id>/`)的读取与提案原地更新。
 * 读:只经 read-fs;写:只经 safe-fs,且只写 `proposals/<id>.yaml`(临时文件 + rename,0600)。
 * `rules/**`、`report.json` 等其它文件 judge 一律不碰。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { stringify } from 'yaml';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { LayerSchema } from '../contracts/atom.js';
import { ProposalSchema } from '../contracts/proposal.js';
import type { IoContext } from '../io/paths.js';
import { readDir } from '../io/read-fs.js';
import { chmod, remove, rename, writeFile } from '../io/safe-fs.js';
import { bad, readRegular, runDir } from './store-read.js';

/** 写出口,可注入(测试用它观察「先写临时文件再 rename」)。 */
export interface StoreFs {
  remove(io: IoContext, target: string): Promise<void>;
  writeFile(io: IoContext, target: string, data: string, opts: { mode: number }): Promise<void>;
  chmod(io: IoContext, target: string, mode: number): Promise<void>;
  rename(io: IoContext, from: string, to: string): Promise<void>;
}
export const SAFE_STORE_FS: StoreFs = { writeFile, chmod, rename, remove };

// 读侧已拆到 `store-read.ts`(闭包里没有 safe-fs);原样再导出,既有调用点不变
export {
  JudgeRunNotFoundError,
  loadRun,
  loadRunEntries,
  runDir,
  type LoadedProposal,
  type RunEntries,
} from './store-read.js';

const JUDGE_KEYS = ['judge', 'judge_attempts'] as const;

/**
 * 产出更新后的提案:只替换 `judge` / `judge_attempts` 两个键,其余键原样保留。
 * judge 与 judge_attempts 互斥:写其中一个就删除另一个。
 */
export function applyJudgeFields(
  raw: Readonly<Record<string, unknown>>,
  fields: { judge: unknown } | { judge_attempts: unknown },
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(JUDGE_KEYS as readonly string[]).includes(k)) next[k] = v;
  }
  Object.assign(next, fields);
  assertOnlyJudgeKeysChanged(raw, next);
  return next;
}

/** 不变量:judge 永远不改提案的其它任何字段。 */
export function assertOnlyJudgeKeysChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if ((JUDGE_KEYS as readonly string[]).includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      bad('更新会改动 judge/judge_attempts 以外的字段');
    }
  }
}

const INGEST_ROOT_KEYS = ['judge', 'judge_attempts', 'reflector'] as const;

/**
 * N4(R20-18.31 ⑥):`judge --ingest` / `--confirm-reflector` 的写原语。与 {@link applyJudgeFields} 的区别:多允许一个键
 * `reflector.confirmed`;**只许改 `judge`、`judge_attempts`、`reflector.confirmed` 三处**,`reflector` 的其余字段
 * (`vendor` 须保持 `unknown`、`model` 须保持 `undeclared`、`provenance` 等)改动即抛 {@link JudgeStateError}。
 * - `judge` 给了:写 `judge` 并删除 `judge_attempts`(与补跑成功语义一致);
 * - `confirmed` 给了:`reflector` 里只替换 / 追加 `confirmed` 一个键,其余字段与键序原样保留。
 */
export function applyIngestFields(
  raw: Readonly<Record<string, unknown>>,
  fields: { judge?: unknown; confirmed?: unknown },
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'judge' && fields.judge !== undefined) continue;
    if (k === 'judge_attempts' && fields.judge !== undefined) continue;
    if (k === 'reflector' && fields.confirmed !== undefined) {
      const r = v as Record<string, unknown>;
      next[k] = { ...r, confirmed: fields.confirmed };
      continue;
    }
    next[k] = v;
  }
  if (fields.judge !== undefined) next['judge'] = fields.judge;
  assertOnlyIngestKeysChanged(raw, next);
  return next;
}

/** 不变量:ingest 写原语永远不改提案的其它字段,也不改 `reflector` 里 `confirmed` 以外的任何字段。 */
export function assertOnlyIngestKeysChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if ((INGEST_ROOT_KEYS as readonly string[]).includes(k) && k !== 'reflector') continue;
    if (k === 'reflector') {
      const b = before[k];
      const a = after[k];
      if (typeof b !== 'object' || b === null || typeof a !== 'object' || a === null) {
        bad('更新会改动 reflector 以外的结构');
      }
      const strip = (o: object): Record<string, unknown> => {
        const { confirmed: _c, ...rest } = o as Record<string, unknown>;
        void _c;
        return rest;
      };
      if (JSON.stringify(strip(b as object)) !== JSON.stringify(strip(a as object))) {
        bad('更新会改动 reflector.confirmed 以外的 reflector 字段');
      }
      continue;
    }
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      bad('更新会改动 judge/judge_attempts/reflector.confirmed 以外的字段');
    }
  }
}

/** 序列化并做 yaml 往返比对;不一致抛 JudgeStateError。调用前预检也用它。 */
export function serializeProposal(next: Readonly<Record<string, unknown>>): string {
  const text = stringify(next, { lineWidth: 0 });
  const back = parseRestrictedYaml(text, 'proposal', 'JUDGE_PROPOSAL_YAML');
  if (!back.ok || JSON.stringify(back.value) !== JSON.stringify(next)) {
    return bad('提案 yaml 往返不一致');
  }
  return text;
}

/**
 * 校验后原子写回:先写同目录唯一名的临时文件(0600),再 rename 覆盖;失败时清掉临时文件。
 * 写回前重读目标,与加载时的原文不同(被人或别的进程改过)→ 中止,不覆盖。
 * 假设单进程写入(无文件锁),与信号库、盐的约定一致。
 */
export async function writeProposal(
  io: IoContext,
  file: string,
  next: Readonly<Record<string, unknown>>,
  expectedText: string,
  fsx: StoreFs = SAFE_STORE_FS,
): Promise<void> {
  const parsed = ProposalSchema.safeParse(next);
  if (!parsed.success) return bad('更新后的提案未通过 ProposalSchema');
  const text = serializeProposal(next);
  if ((await readRegular(file, '提案文件')) !== expectedText) {
    return bad('提案文件在评审期间被改动');
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsx.writeFile(io, tmp, text, { mode: 0o600 });
    await fsx.chmod(io, tmp, 0o600);
    await fsx.rename(io, tmp, file);
  } catch (e) {
    await fsx.remove(io, tmp).catch(() => undefined);
    throw e;
  }
}

/** 已知原子 id:仓库 `rules/<layer>/*.md` 的文件名 + 本 run 暂存的规则。读不到的目录当空。 */
export async function loadKnownAtomIds(io: IoContext, runId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const roots = [path.join(io.repoRoot, 'rules'), path.join(runDir(io, runId), 'rules')];
  for (const root of roots) {
    for (const layer of LayerSchema.options) {
      let entries;
      try {
        entries = await readDir(path.join(root, layer));
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile && e.name.endsWith('.md')) ids.add(e.name.slice(0, -3));
      }
    }
  }
  return ids;
}

/**
 * 渲染核心:调度各适配器、校验输出、统一收尾(规范化、独占头、排序、报告合并)。
 * 本文件不含任何具体 agent 的逻辑。
 *
 * 渲染器(B07/B08)须知:
 * - 返回的 OutFile.content 可以是未规范化文本,core 会 canonicalText;**不要自己加独占头**
 *   (mode='owned' 的头由 core 统一加,已有头会被原位更新,不会重复)。
 * - mode='managed-block' 的 content 必须恰好是一个 intact 托管块(用 renderManagedBlock 生成),块外不得有内容。
 * - atomIds 只能引用 input.resolved 里 coreEligible=true 的原子;personal 原子进输出 ⇒ 抛错。
 * - 文件的 agent 必须等于适配器自己的 agent。
 */
import { canonicalText } from '../io/canonical-text.js';
import { RenderOutputSchema } from '../contracts/render.js';
import type { OutFile, RenderInput, RenderOutput, RenderReport } from '../contracts/render.js';
import { parseManagedBlocks } from './managed-block.js';
import { applyOwnedHeader, headerSyntax } from './owned-header.js';
import { assertNoCollisions, outKey, sortOutFiles } from './out-layout.js';
import type { AdapterRegistry } from './registry.js';
import { defaultRegistry } from './registry.js';
import { emptyReport, mergeReports } from './report.js';

export type RenderCoreErrorCode =
  | 'CORE_AGENT_MISMATCH'
  | 'CORE_UNKNOWN_ATOM'
  | 'CORE_PERSONAL_LEAK'
  | 'CORE_BAD_MANAGED_BLOCK'
  | 'CORE_BAD_OUTPUT';

export class RenderCoreError extends Error {
  constructor(
    readonly code: RenderCoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RenderCoreError';
  }
}

const STAGES = ['renderRules', 'renderSkills', 'renderAgents'] as const;

function checkManagedBlock(f: OutFile): void {
  if (headerSyntax(f.relPath) === undefined) {
    throw new RenderCoreError(
      'CORE_BAD_MANAGED_BLOCK',
      `${outKey(f)}:该文件类型没有注释语法,不能放托管块`,
    );
  }
  if (f.content.startsWith('\uFEFF')) {
    throw new RenderCoreError('CORE_BAD_MANAGED_BLOCK', `${outKey(f)}:托管块文件不得以 BOM 开头`);
  }
  const text = f.content;
  const parsed = parseManagedBlocks(text);
  if (!parsed.ok) {
    throw new RenderCoreError('CORE_BAD_MANAGED_BLOCK', `${outKey(f)}:${parsed.message}`);
  }
  const only = parsed.blocks[0];
  if (parsed.blocks.length !== 1 || !only) {
    throw new RenderCoreError(
      'CORE_BAD_MANAGED_BLOCK',
      `${outKey(f)}:managed-block 文件必须恰好含一个托管块,实际 ${parsed.blocks.length} 个`,
    );
  }
  if (only.storedSha !== only.actualSha) {
    throw new RenderCoreError('CORE_BAD_MANAGED_BLOCK', `${outKey(f)}:托管块 sha256 与块体不符`);
  }
  if (only.start !== 0 || only.end !== text.length) {
    throw new RenderCoreError('CORE_BAD_MANAGED_BLOCK', `${outKey(f)}:托管块之外不得有内容`);
  }
}

function checkAtoms(f: OutFile, input: RenderInput): void {
  for (const id of f.atomIds) {
    const r = input.resolved.find((x) => x.atom.fm.id === id);
    if (!r) throw new RenderCoreError('CORE_UNKNOWN_ATOM', `${outKey(f)} 引用了未知原子 ${id}`);
    if (!r.coreEligible) {
      throw new RenderCoreError(
        'CORE_PERSONAL_LEAK',
        `${outKey(f)} 含不得进入 core 输出的原子 ${id}(层 ${r.layer})`,
      );
    }
  }
}

/**
 * 跑完所有适配器,返回收尾后的输出:文件按 `<agent>/<target>/<relPath>` 字节序排序,报告合并去重排序。
 * 同一输入的两次调用结果逐字节相同(假设适配器自身确定)。不落盘。
 */
export function renderAll(
  input: RenderInput,
  registry: AdapterRegistry = defaultRegistry,
): RenderOutput {
  const files: OutFile[] = [];
  const reports: RenderReport[] = [];
  const extra: RenderReport = emptyReport();
  for (const adapter of registry.list()) {
    for (const stage of STAGES) {
      const fn = adapter[stage];
      if (!fn) continue;
      // 每个阶段都拿到独立副本:适配器改了输入也影响不到后面的适配器
      const raw: unknown = fn.call(adapter, structuredClone(input));
      const parsed = RenderOutputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new RenderCoreError(
          'CORE_BAD_OUTPUT',
          `${adapter.agent}.${stage} 的输出不符合 RenderOutputSchema:${parsed.error.message}`,
        );
      }
      for (const f of parsed.data.files) {
        if (f.agent !== adapter.agent) {
          throw new RenderCoreError(
            'CORE_AGENT_MISMATCH',
            `${adapter.agent}.${stage} 产出了属于 ${f.agent} 的文件 ${outKey(f)}`,
          );
        }
        checkAtoms(f, input);
        let content = canonicalText(f.content);
        if (f.mode === 'managed-block') {
          checkManagedBlock({ ...f, content });
        } else {
          const h = applyOwnedHeader(content, f.relPath, input.kitVersion);
          content = h.content;
          if (!h.applied) {
            extra.sideEffects.push(`${outKey(f)}:该文件类型没有注释语法,未加独占文件头`);
          }
        }
        files.push({ ...f, content });
      }
      reports.push(parsed.data.report);
    }
  }
  assertNoCollisions(files);
  return {
    files: sortOutFiles(files),
    report: mergeReports([...reports, extra]),
  };
}

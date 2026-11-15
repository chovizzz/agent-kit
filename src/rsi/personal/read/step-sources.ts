/**
 * `runPersonalStep` 的三个**只读**来源端口的生产适配器(装配块 A 段;端口定义在 `candidate-ports.ts`,SOLID 的 D:这里只依赖窄端口与注入的读函数):
 *  - {@link makeStagedSource}:`StagedSource` —— 暂存提案 = `counts.json` 的暂存 run(口径与 `pending.ts` 的 `stagedRuns` **同一份**:未 tainted、证据非空、全部归属 P)
 *    逐个按 `loadRunEntries` 的口径装载;任一失败**抛错**(不跳过坏 run 去「尽量」);
 *  - {@link makeSignalLookup}:`SignalLookup` —— 信号库月文件逐行过 `SignalSchema`,任一行不合规整体失败(抛错,不返回「少几条」冒充成功);按 `sig_id` 只回命中的;
 *  - {@link makePresetSource}:`PresetSource` —— 预置技能(包内 payload 里 `kind=skill` 的条目,`source=package`)的比对形;读失败 / 形状不合规**抛错**,绝不返回空。
 * 全部只读(read-fs);工厂创建与 import 不读盘,只有调用端口方法才读。
 */
import type { RsiCounts } from '../../../contracts/rsi.js';
import { SignalSchema, type Signal } from '../../../contracts/signal.js';
import type { IoContext } from '../../../io/paths.js';
import { loadRunEntries, type RunEntries } from '../../../judge/store-read.js';
import type { DedupeTarget } from '../../../reflect/dedupe.js';
import { listMonthFiles, scanMonthFile } from '../../../signals/store-scan.js';
import { stagedRuns } from '../../pending.js';
import type { PresetSource, SignalLookup, StagedSource } from '../candidate-ports.js';

type StagedEntry = RsiCounts['staged'][number];

export interface StagedSourceDeps {
  io: IoContext;
  /** `counts.json` 的暂存 run 清单;读不到 / 不合规 → 抛错 */
  staged(): Promise<readonly StagedEntry[]>;
  /** 当前配置下的项目归属(`P` = 采集中) */
  classify(key: string): Promise<'P' | 'X' | 'U'>;
  /** 测试缝:缺省 `loadRunEntries` */
  loadEntries?: (io: IoContext, runId: string) => Promise<RunEntries>;
}

export function makeStagedSource(d: StagedSourceDeps): StagedSource {
  const load = d.loadEntries ?? loadRunEntries;
  return {
    async list() {
      const entries = await d.staged();
      const cls = new Map<string, 'P' | 'X' | 'U'>();
      for (const e of entries) {
        for (const k of e.evidence_keys) if (!cls.has(k)) cls.set(k, await d.classify(k));
      }
      const out: Awaited<ReturnType<StagedSource['list']>> = [];
      for (const run of stagedRuns(entries, (k) => cls.get(k) ?? 'U')) {
        const r = await load(d.io, run.runId);
        for (const lp of r.loaded) {
          out.push({ runId: run.runId, proposal: lp.proposal, ruleText: lp.ruleText });
        }
      }
      return out;
    },
  };
}

export function makeSignalLookup(d: { io: IoContext }): SignalLookup {
  return {
    async getMany(sigs) {
      if (sigs.length === 0) return [];
      const wanted = new Set(sigs);
      const found = new Map<string, Signal>();
      for (const file of await listMonthFiles(d.io, 'signals')) {
        await scanMonthFile(file, (_raw, value) => {
          const p = SignalSchema.safeParse(value);
          if (!p.success) return false;
          if (wanted.has(p.data.sig_id)) found.set(p.data.sig_id, p.data);
          return true;
        });
      }
      return [...found.values()].sort((a, b) => (a.sig_id < b.sig_id ? -1 : 1));
    },
  };
}

/** 包内 payload 的最小形状(`LoadedPayload` 的子集;装配处用 `loadPayload` 注入) */
export interface PresetPayload {
  manifest: { files: readonly { kind: string; payload_path: string }[] };
  contents: ReadonlyMap<string, string>;
}

class PresetError extends Error {
  readonly code = 'RSI_PRESET_READ';
  constructor(what: string) {
    super(`preset read: ${what}`);
  }
}

const SKILL_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** 一份 SKILL.md → 比对形:`id` = frontmatter `name`,`do` = `description`,`why` = 正文;缺任一项 → 抛错 */
export function presetOf(text: string): DedupeTarget {
  const m = SKILL_RE.exec(text.replace(/\r\n/g, '\n'));
  if (m === null) throw new PresetError('no_frontmatter');
  const field = (k: string): string | undefined => {
    const hit = new RegExp(`^${k}:[ \\t]*(.+)$`, 'm').exec(m[1] as string);
    return hit?.[1]?.trim();
  };
  const name = field('name');
  const description = field('description');
  const body = (m[2] as string).trim();
  if (name === undefined || description === undefined || body === '') {
    throw new PresetError('skill_shape');
  }
  return { id: name, do: description, why: body };
}

export function makePresetSource(d: { payload(): Promise<PresetPayload> }): PresetSource {
  return {
    async presets() {
      const p = await d.payload();
      const byId = new Map<string, DedupeTarget>();
      // 同名技能在多个 agent 下各有一份渲染:按 payload_path 升序取第一份(确定性;不是「任选」)
      const files = [...p.manifest.files].sort((a, b) =>
        a.payload_path < b.payload_path ? -1 : 1,
      );
      for (const f of files) {
        if (f.kind !== 'skill') continue;
        // 只收 SKILL.md(skill 目录里的其它文件不是预置技能的主体)
        if (!f.payload_path.endsWith('/SKILL.md')) continue;
        const text = p.contents.get(f.payload_path);
        if (text === undefined) throw new PresetError('content_missing');
        const t = presetOf(text);
        if (!byId.has(t.id)) byId.set(t.id, t);
      }
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    },
  };
}

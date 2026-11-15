/**
 * `runPersonalStep` 的三个**只读**来源端口的生产适配器(装配块 A 段;端口定义在 `candidate-ports.ts`,SOLID 的 D:这里只依赖窄端口与注入的读函数):
 *  - {@link makeStagedSource}:`StagedSource` —— 暂存提案 = `counts.json` 的暂存 run(口径与 `pending.ts` 的 `stagedRuns` **同一份**:未 tainted、证据非空、全部归属 P)
 *    逐个按 `loadRunEntries` 的口径装载;任一失败**抛错**(不跳过坏 run 去「尽量」);
 *  - {@link makeSignalLookup}:`SignalLookup` —— 信号库月文件逐行过 `SignalSchema`,任一行不合规整体失败(抛错,不返回「少几条」冒充成功);按 `sig_id` 只回命中的;
 *  - {@link makePresetSource}:`PresetSource` —— 预置技能(包内 payload 里 `kind=skill` 的条目,`source=package`)的比对形;同 id 比对形不同的副本全部保留(完全相同的才合并);读失败 / 形状不合规**抛错**,绝不返回空。
 * 全部只读(read-fs);工厂创建与 import 不读盘,只有调用端口方法才读。
 */
import { parse as parseYaml } from 'yaml';
import type { RsiCounts } from '../../../contracts/rsi.js';
import { SignalSchema, type Signal } from '../../../contracts/signal.js';
import type { IoContext } from '../../../io/paths.js';
import { loadRunEntries, type RunEntries } from '../../../judge/store-read.js';
import type { DedupeTarget } from '../../../reflect/dedupe.js';
import { listMonthFiles, scanMonthFile } from '../../../signals/store-scan.js';
import { stagedRuns } from '../../pending.js';
import type { PresetSource, SignalLookup, StagedSource } from '../candidate-port-types.js';

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

export interface SignalLookupDeps {
  io: IoContext;
  /** 测试缝:缺省 `listMonthFiles` / `scanMonthFile`(信号库月文件的受限只读扫描) */
  list?: typeof listMonthFiles;
  scan?: typeof scanMonthFile;
}

export function makeSignalLookup(d: SignalLookupDeps): SignalLookup {
  const list = d.list ?? listMonthFiles;
  const scan = d.scan ?? scanMonthFile;
  return {
    async getMany(sigs) {
      if (sigs.length === 0) return [];
      const wanted = new Set(sigs);
      const found = new Map<string, Signal>();
      for (const file of await list(d.io, 'signals')) {
        const id = await scan(file, (_raw, value) => {
          const p = SignalSchema.safeParse(value);
          if (!p.success) return false;
          if (wanted.has(p.data.sig_id)) found.set(p.data.sig_id, p.data);
          return true;
        });
        // 已枚举的月文件在打开前消失(`scan` 返回 null):查询只完成了一部分,不能当成「这些 sig_id 不存在」
        if (id === null) throw new SignalLookupError('month_file_vanished');
      }
      return [...found.values()].sort((a, b) => (a.sig_id < b.sig_id ? -1 : 1));
    },
  };
}

class SignalLookupError extends Error {
  readonly code = 'RSI_SIGNAL_LOOKUP';
  constructor(what: string) {
    super(`signal lookup: ${what}`);
  }
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
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * 一份 SKILL.md → 比对形:`id` = frontmatter `name`,`do` = `description`,`why` = 正文。
 * frontmatter 用 YAML 解析(折叠 / 保留多行标量、引号都取到真实值);`name` / `description` 必须是非空字符串、正文非空,否则抛错(不返回部分事实)。
 */
export function presetOf(text: string): DedupeTarget {
  const m = SKILL_RE.exec(text.replace(/\r\n/g, '\n'));
  if (m === null) throw new PresetError('no_frontmatter');
  let fm: unknown;
  try {
    fm = parseYaml(m[1] as string);
  } catch {
    throw new PresetError('frontmatter_yaml');
  }
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
    throw new PresetError('frontmatter_shape');
  }
  const { name, description } = fm as Record<string, unknown>;
  const body = (m[2] as string).trim();
  if (!nonEmpty(name) || !nonEmpty(description) || body === '') {
    throw new PresetError('skill_shape');
  }
  return { id: name.trim(), do: description.trim(), why: body };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 同名技能在多个 agent 下各有一份渲染。下游(`overlapsPreset` / G4 近重复)只把预置当**一组比对目标**逐个 `findDuplicate`,
 * `id` 仅用作 `duplicateOf` 标签、不做键查找,所以同 id 可以有多条目标。因此**不按 id 取第一份**(那会让只与被丢弃副本高度重叠的候选漏过):
 * 比对形(id + do + why)完全相同的副本合并为一条,**不同的全部保留**;顺序按 (id, do, why) 码元序,确定。
 */
export function makePresetSource(d: { payload(): Promise<PresetPayload> }): PresetSource {
  return {
    async presets() {
      const p = await d.payload();
      const byForm = new Map<string, DedupeTarget>();
      for (const f of p.manifest.files) {
        if (f.kind !== 'skill') continue;
        // 只收 SKILL.md(skill 目录里的其它文件不是预置技能的主体)
        if (!f.payload_path.endsWith('/SKILL.md')) continue;
        const text = p.contents.get(f.payload_path);
        if (text === undefined) throw new PresetError('content_missing');
        const t = presetOf(text);
        byForm.set(JSON.stringify([t.id, t.do, t.why]), t);
      }
      return [...byForm.values()].sort(
        (a, b) => cmp(a.id, b.id) || cmp(a.do, b.do) || cmp(a.why, b.why),
      );
    },
  };
}

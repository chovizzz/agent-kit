/**
 * kit 条目的构造与指纹(contracts §20.15 R20-15.11 / 15.12)。纯函数。
 *
 * 一个 kit 条目 = 形状表里的**完整**版本化形状(事件、matcher、类型、精确命令、kit 生成的全部字段),
 * 指纹 = sha256(canonical JSON `{event, entry}`)——只比较命令串不够(R20-15.11)。pi 的条目是整份扩展文件,指纹 = 文件字节的 sha256。
 */
import { createHash } from 'node:crypto';
import {
  HOOK_VARIANTS,
  entriesOf,
  sourceOf,
  type FileShape,
  type HookEntrySpec,
  type HookVariant,
  type HookWrapperSpec,
  type JsonMergeShape,
} from '../../contracts/rsi-hooks.js';
import { canonicalJson } from '../../io/canonical-json.js';

export type JsonObject = Record<string, unknown>;

export function sha256Hex(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

/** 形状表里的包装对象 → 要写进配置文件的 JSON 对象(键序固定:matcher、hooks;钩子内 type、command、timeout) */
export function wrapperJson(w: HookWrapperSpec): JsonObject {
  const out: JsonObject = {};
  if (w.matcher !== undefined) out['matcher'] = w.matcher;
  out['hooks'] = w.hooks.map((h) => ({ type: h.type, command: h.command, timeout: h.timeout }));
  return out;
}

/** 完整条目指纹 */
export function entryFingerprint(event: string, wrapper: unknown): string {
  return sha256Hex(canonicalJson({ event, entry: wrapper }));
}

export interface JsonSpecView {
  readonly variant: HookVariant;
  readonly event: string;
  readonly wrapper: JsonObject;
  readonly fingerprint: string;
}

/** 形状表里全部变体的条目(同一指纹可在多个变体里出现,各记一条) */
export function allJsonSpecs(shape: JsonMergeShape): readonly JsonSpecView[] {
  const out: JsonSpecView[] = [];
  for (const variant of HOOK_VARIANTS) {
    const es: readonly HookEntrySpec[] | null = entriesOf(shape, variant);
    if (es === null) continue;
    for (const e of es) {
      const wrapper = wrapperJson(e.wrapper);
      out.push({
        variant,
        event: e.event,
        wrapper,
        fingerprint: entryFingerprint(e.event, wrapper),
      });
    }
  }
  return out;
}

export function variantJsonSpecs(
  shape: JsonMergeShape,
  variant: HookVariant,
): readonly JsonSpecView[] | null {
  if (entriesOf(shape, variant) === null) return null;
  return allJsonSpecs(shape).filter((s) => s.variant === variant);
}

/** pi:各变体的扩展源码 */
export function allFileSources(
  shape: FileShape,
): readonly { variant: HookVariant; source: string; fingerprint: string }[] {
  const out: { variant: HookVariant; source: string; fingerprint: string }[] = [];
  for (const variant of HOOK_VARIANTS) {
    const source = sourceOf(shape, variant);
    if (source !== null) out.push({ variant, source, fingerprint: sha256Hex(source) });
  }
  return out;
}

/** pi 条目的事件位置(账本里 `event` 的取值) */
export const FILE_ENTRY_EVENT = 'file';

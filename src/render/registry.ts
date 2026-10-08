/**
 * 适配器注册表。静态 import 五个 `adapters/<agent>/index.ts`(B01 预建桩,B07/B08 替换内容、保持导出形状),
 * 所以接入新渲染器不会改这个文件。`createRegistry` 供测试注入假适配器。
 */
import { RENDER_AGENT_IDS } from '../contracts/common.js';
import type { RenderAgentId } from '../contracts/common.js';
import type { Adapter } from '../contracts/render.js';
import { adapter as claude } from '../../adapters/claude/index.js';
import { adapter as codex } from '../../adapters/codex/index.js';
import { adapter as kimi } from '../../adapters/kimi/index.js';
import { adapter as opencode } from '../../adapters/opencode/index.js';
import { adapter as pi } from '../../adapters/pi/index.js';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface AdapterRegistry {
  /** 固定顺序(RENDER_AGENT_IDS 的顺序),与注册先后无关 */
  list(): readonly Adapter[];
  get(agent: RenderAgentId): Adapter | undefined;
}

export function createRegistry(adapters: readonly Adapter[]): AdapterRegistry {
  const map = new Map<RenderAgentId, Adapter>();
  for (const a of adapters) {
    if (!(RENDER_AGENT_IDS as readonly string[]).includes(a.agent)) {
      throw new RegistryError(`未知的渲染目标:${String(a.agent)}`);
    }
    if (map.has(a.agent)) throw new RegistryError(`适配器重复注册:${a.agent}`);
    map.set(a.agent, a);
  }
  const ordered = RENDER_AGENT_IDS.flatMap((id) => {
    const a = map.get(id);
    return a ? [a] : [];
  });
  return { list: () => ordered, get: (agent) => map.get(agent) };
}

/** 默认注册表:五个内置渲染器。 */
export const defaultRegistry: AdapterRegistry = createRegistry([claude, codex, pi, kimi, opencode]);

import { stringify as tomlStringify } from 'smol-toml';

/**
 * Codex 自定义代理文件的字段顺序(固定)。name / description / developer_instructions 必填,
 * 其余是 config.toml 的键(codex-subagents.md "Custom agent file schema")。
 * 序列化确定性靠两点:键按本列表顺序插入对象;smol-toml 的 stringify 按插入序输出。
 */
export const CODEX_AGENT_FIELD_ORDER = [
  'name',
  'description',
  'model',
  'sandbox_mode',
  'developer_instructions',
] as const;
export type CodexAgentField = (typeof CODEX_AGENT_FIELD_ORDER)[number];

export type CodexAgentFields = Partial<Record<CodexAgentField, string>>;

export function codexAgentToml(fields: CodexAgentFields): string {
  const ordered: Record<string, string> = {};
  for (const key of CODEX_AGENT_FIELD_ORDER) {
    const v = fields[key];
    if (v !== undefined) ordered[key] = v;
  }
  return tomlStringify(ordered);
}

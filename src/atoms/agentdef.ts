import { NeutralAgentSchema, type NeutralAgent } from '../contracts/agent-def.js';
import { zodIssuesToDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import { parseRestrictedYaml } from './frontmatter.js';

export interface AgentParse {
  agent: NeutralAgent | undefined;
  diagnostics: Diagnostic[];
}

/**
 * 解析 `agents/<name>.yaml`。字段与 `model_tier` 枚举由 NeutralAgentSchema 管(失败 SCHEMA_INVALID);
 * `name` 必须等于文件名(AGENT_NAME_FILE_MISMATCH)。具体模型名的扫描在 lint.ts(基于原文)。
 */
export function parseAgent(source: string, relPath: string, stem: string): AgentParse {
  const y = parseRestrictedYaml(source.replace(/^﻿/, ''), relPath, 'AGENT_YAML_SYNTAX');
  if (!y.ok) return { agent: undefined, diagnostics: y.diagnostics };
  const res = NeutralAgentSchema.safeParse(y.value);
  if (!res.success) {
    return { agent: undefined, diagnostics: zodIssuesToDiagnostics(res.error, relPath) };
  }
  const diagnostics: Diagnostic[] = [];
  if (res.data.name !== stem) {
    diagnostics.push({
      code: 'AGENT_NAME_FILE_MISMATCH',
      severity: 'error',
      path: `${relPath}#/name`,
      message: `name「${res.data.name}」必须等于文件名「${stem}」`,
    });
  }
  return { agent: res.data, diagnostics };
}

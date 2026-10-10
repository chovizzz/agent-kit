import { describe, expect, it } from 'vitest';
import { isExternalToolName } from '../../src/signals/external-content.js';
import {
  parseCliVersion,
  resolveAgentVersion,
  UNKNOWN_VERSION,
} from '../../src/signals/version.js';

describe('CLI 版本解析(口径 §3)', () => {
  it('取首个 X.Y.Z[-pre],忽略前缀与括号说明', () => {
    expect(parseCliVersion('2.1.294 (Claude Code)')).toBe('2.1.294');
    expect(parseCliVersion('codex-cli 0.161.0')).toBe('0.161.0');
    expect(parseCliVersion('v0.149.0-alpha.4.3 build')).toBe('0.149.0-alpha.4.3');
    expect(parseCliVersion('no version here')).toBeUndefined();
  });

  it('会话里有版本 → session_meta;没有 → 兜底值 + collector_fallback;兜底也没有 → unknown', () => {
    expect(resolveAgentVersion('2.1.294', '9.9.9')).toEqual({
      version: '2.1.294',
      source: 'session_meta',
    });
    expect(resolveAgentVersion(null, '0.87.1')).toEqual({
      version: '0.87.1',
      source: 'collector_fallback',
    });
    expect(resolveAgentVersion(null, undefined)).toEqual({
      version: UNKNOWN_VERSION,
      source: 'unknown',
    });
  });
});

describe('外部内容判定(保守)', () => {
  it('抓取/浏览器/MCP 工具判外部;本地工具判非外部(正向对照)', () => {
    for (const n of [
      'WebFetch',
      'WebSearch',
      'mcp__srv__tool',
      'browser_click',
      'playwright_nav',
    ]) {
      expect(isExternalToolName(n), n).toBe(true);
    }
    for (const n of ['Bash', 'Read', 'Edit', 'ToolSearch', 'Grep', undefined, '']) {
      expect(isExternalToolName(n), String(n)).toBe(false);
    }
  });
});

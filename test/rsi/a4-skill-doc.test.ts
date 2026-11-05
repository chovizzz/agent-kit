/**
 * R20-16.29 ④:skill `agent-kit-rsi` 里的「提交格式」示例与 kit 的校验同源,防止文档和 schema 漂移。
 * 示例 JSON 必须通过 `checkReflectorShape`(预检)与完整 `validateReflectorOutput`(`dropped` 为空);
 * schema 的每个提案字段都要在 skill 里点名;skill 写的名额数字必须等于 `RSI_INGEST_QUOTA_*`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReflectorOutputSchema } from '../../src/contracts/reflect.js';
import {
  RSI_INGEST_MAX_PROPOSALS,
  RSI_INGEST_QUOTA_GLOBAL,
  RSI_INGEST_QUOTA_PER_AGENT,
} from '../../src/contracts/rsi.js';
import { DEFAULT_ATOM_MAX_BYTES } from '../../src/contracts/common.js';
import { readText } from '../../src/io/read-fs.js';
import {
  MAX_INGEST_OUTPUT_BYTES,
  checkReflectorShape,
  validateReflectorOutput,
} from '../../src/reflect/validate.js';
import { ROOT } from './closure-util.js';

const SKILL = await readText(path.join(ROOT, 'skills/agent-kit-rsi/SKILL.md'));

/** 「提交格式」一节里唯一的 ```json 围栏 */
function exampleJson(): string {
  const section = SKILL.slice(SKILL.indexOf('## 提交格式'));
  const m = /```json\n([\s\S]*?)\n```/.exec(section);
  if (m === null) throw new Error('skill 的「提交格式」一节里没有 json 示例');
  return m[1] as string;
}

const CTX = {
  atomMaxBytes: DEFAULT_ATOM_MAX_BYTES,
  maxProposals: RSI_INGEST_MAX_PROPOSALS,
  maxOutputBytes: MAX_INGEST_OUTPUT_BYTES,
} as const;

describe('skill 提交格式与校验同源(R20-16.29 ④)', () => {
  it('skill 示例 JSON 通过形状与完整校验', () => {
    const raw = exampleJson();
    const shape = checkReflectorShape(raw, CTX);
    expect(shape.ok, JSON.stringify(shape)).toBe(true);
    const full = validateReflectorOutput(raw, {
      ...CTX,
      allowedAliases: new Set(['e1', 'e2', 'e3']),
      excerpts: [],
      existingIds: new Set<string>(),
      redactor: { pass2: () => ({ clean: true }) } as never,
    });
    expect(full.ok, JSON.stringify(full)).toBe(true);
    if (full.ok) {
      expect(full.dropped).toEqual({});
      expect(full.proposals.length).toBeGreaterThan(0);
    }
  });
  it('skill 示例的顶层是对象且含 proposals 数组(不是裸数组)', () => {
    const doc: unknown = JSON.parse(exampleJson());
    expect(Array.isArray(doc)).toBe(false);
    expect(Array.isArray((doc as { proposals?: unknown }).proposals)).toBe(true);
  });
  it('schema 的每个提案字段都在 skill 里点名,必填字段都出现在示例里', () => {
    const shape = makeReflectorOutputSchema().shape.proposals.element.shape as Record<
      string,
      { safeParse(v: unknown): { success: boolean } }
    >;
    const keys = Object.keys(shape);
    expect(keys.length).toBeGreaterThan(0);
    const example = JSON.parse(exampleJson()) as { proposals: Record<string, unknown>[] };
    for (const k of keys) {
      expect(SKILL, `skill 没提到字段 ${k}`).toContain(`\`${k}\``);
      if (!shape[k]?.safeParse(undefined).success) {
        expect(Object.keys(example.proposals[0] ?? {}), `示例缺必填字段 ${k}`).toContain(k);
      }
    }
    // 示例里不得有 schema 之外的键(strictObject 会拒)
    for (const k of Object.keys(example.proposals[0] ?? {})) expect(keys).toContain(k);
  });
  it('skill 写的名额数字等于 RSI_INGEST_QUOTA_* 常量', () => {
    expect(SKILL).toContain(
      `每个 agent 每天 ${RSI_INGEST_QUOTA_PER_AGENT} 次,全局 ${RSI_INGEST_QUOTA_GLOBAL} 次`,
    );
  });
  it('skill 写明格式类拒绝不占名额、不消费 digest', () => {
    for (const code of ['not_json_object', 'schema_invalid', 'too_many_proposals']) {
      expect(SKILL).toContain(code);
    }
    expect(SKILL).toContain('不占当天名额');
  });
});

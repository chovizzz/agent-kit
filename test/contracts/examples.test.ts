import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { KitConfigSchema, zodIssuesToDiagnostics } from '../../src/contracts/index.js';
import { readText } from '../../src/io/read-fs.js';
import { SCHEMAS } from './registry.js';

interface Example {
  kind: 'valid' | 'invalid';
  schema: string;
  json: unknown;
  line: number;
}

const DOC = new URL('../../docs/contracts.md', import.meta.url).pathname;
const KIT_TOML = new URL('../../kit.toml', import.meta.url).pathname;

// 标记注释后面(允许夹空行)紧跟一个 ```json 代码块
const MARKER = /<!-- example:(valid|invalid) schema=([A-Za-z]+) -->\s*```json\n([\s\S]*?)\n```/g;

async function loadExamples(): Promise<{ examples: Example[]; markerCount: number }> {
  const md = await readText(DOC);
  const examples: Example[] = [];
  for (const m of md.matchAll(MARKER)) {
    examples.push({
      kind: m[1] as Example['kind'],
      schema: m[2] as string,
      json: JSON.parse(m[3] as string),
      line: md.slice(0, m.index).split('\n').length,
    });
  }
  const markerCount = (md.match(/^<!-- example:/gm) ?? []).length;
  return { examples, markerCount };
}

describe('docs/contracts.md 示例 JSON', async () => {
  const { examples, markerCount } = await loadExamples();

  it('每个标记后都紧跟一个可解析的 json 块(没有孤儿标记)', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.length).toBe(markerCount);
  });

  it('每个示例引用的 schema 都已登记', () => {
    for (const e of examples) {
      expect(Object.keys(SCHEMAS), `docs/contracts.md:${e.line}`).toContain(e.schema);
    }
  });

  it('每个已登记 schema 至少有 1 个合法示例和 1 个错误示例(防示例静默缺失)', () => {
    for (const name of Object.keys(SCHEMAS)) {
      const mine = examples.filter((e) => e.schema === name);
      expect(
        mine.some((e) => e.kind === 'valid'),
        `${name} 缺合法示例`,
      ).toBe(true);
      expect(
        mine.some((e) => e.kind === 'invalid'),
        `${name} 缺错误示例`,
      ).toBe(true);
    }
  });

  it('原子 frontmatter 有 ≥3 个故意错误示例', () => {
    const bad = examples.filter((e) => e.schema === 'AtomFrontmatter' && e.kind === 'invalid');
    expect(bad.length).toBeGreaterThanOrEqual(3);
  });

  for (const e of examples) {
    it(`${e.kind} ${e.schema} (docs/contracts.md:${e.line})`, () => {
      const schema = SCHEMAS[e.schema];
      if (!schema) throw new Error(`未登记的 schema:${e.schema}`);
      const r = schema.safeParse(e.json);
      if (e.kind === 'valid') {
        expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
      } else {
        expect(r.success).toBe(false);
      }
    });
  }
});

describe('错误示例是因为「预期的原因」失败', () => {
  it('must 无 verifier 的诊断指向 verifier/type', async () => {
    const { examples } = await loadExamples();
    const ex = examples.find(
      (e) =>
        e.schema === 'AtomFrontmatter' &&
        e.kind === 'invalid' &&
        (e.json as { id: string }).id === 'must-without-verifier',
    );
    expect(ex).toBeDefined();
    const r = SCHEMAS['AtomFrontmatter']!.safeParse(ex!.json);
    expect(r.success).toBe(false);
    if (!r.success) {
      const ds = zodIssuesToDiagnostics(r.error, 'rules/org/must-without-verifier.md');
      expect(ds.map((d) => d.path)).toEqual(['rules/org/must-without-verifier.md#/verifier/type']);
      expect(ds.every((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    }
  });

  it('把 must 示例改成合法(补 verifier)就通过——证明失败确实由这一项引起', async () => {
    const { examples } = await loadExamples();
    const ex = examples.find(
      (e) =>
        e.schema === 'AtomFrontmatter' &&
        e.kind === 'invalid' &&
        (e.json as { id: string }).id === 'must-without-verifier',
    )!;
    const fixed = { ...(ex.json as object), verifier: { type: 'script', ref: 'scripts/check.sh' } };
    expect(SCHEMAS['AtomFrontmatter']!.safeParse(fixed).success).toBe(true);
  });
});

describe('kit.toml 示例', () => {
  it('解析后通过 KitConfigSchema,且 enforce=block(决策 ② 收口)', async () => {
    const parsed = parseToml(await readText(KIT_TOML));
    const r = KitConfigSchema.safeParse(parsed);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
    if (r.success) {
      expect(r.data.budget.enforce).toBe('block');
      expect(r.data.budget.pi?.limit_source).toBe('assumed');
      expect(Object.keys(r.data.channels)).toEqual(['canary', 'stable']);
    }
  });

  it('未知顶层键被拒(strict)', async () => {
    const parsed = parseToml(await readText(KIT_TOML)) as Record<string, unknown>;
    expect(KitConfigSchema.safeParse({ ...parsed, surprise: 1 }).success).toBe(false);
  });
});

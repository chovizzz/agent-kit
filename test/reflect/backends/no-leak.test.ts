import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLlm } from '../../../src/io/llm-exec.js';
import * as indexMod from '../../../src/reflect/backends/index.js';
import * as claudeMod from '../../../src/reflect/backends/cli-claude.js';
import * as codexMod from '../../../src/reflect/backends/cli-codex.js';
import * as piMod from '../../../src/reflect/backends/cli-pi.js';
import * as commonMod from '../../../src/reflect/backends/cli-common.js';
import * as cooldownMod from '../../../src/reflect/backends/cooldown.js';
import * as gateMod from '../../../src/reflect/backends/gate.js';
import * as lockMod from '../../../src/reflect/backends/lock.js';
import * as stubMod from '../../../src/reflect/backends/stub.js';
import { readDir, readText } from '../../../src/io/read-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';

const SRC = path.join(REPO_ROOT, 'src');
const BACKENDS = path.join(SRC, 'reflect', 'backends') + path.sep;
const LLM_EXEC = path.join(SRC, 'io', 'llm-exec.ts');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(p)));
    else if (e.isFile && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 近似去掉注释(够用:本仓源码里没有把 // 或 /* 放进字符串的写法影响这里的扫描)。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LLM_SPECIFIER = /['"`][^'"`\n]*llm-exec[^'"`\n]*['"`]/;
const MODULES = {
  index: indexMod,
  claude: claudeMod,
  codex: codexMod,
  pi: piMod,
  common: commonMod,
  cooldown: cooldownMod,
  gate: gateMod,
  lock: lockMod,
  stub: stubMod,
};

/** 深度遍历导出值,看有没有任何一处就是 runLlm 本身(按身份比较),或名字叫 runLlm。 */
function containsRunLlm(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === runLlm) return true;
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  if (seen.has(v)) return false;
  seen.add(v);
  if (typeof v === 'function' && v.name === 'runLlm') return true;
  for (const k of Reflect.ownKeys(v as object)) {
    if (k === 'runLlm') return true;
    let child: unknown;
    try {
      child = (v as Record<string | symbol, unknown>)[k];
    } catch {
      continue;
    }
    if (containsRunLlm(child, seen)) return true;
  }
  return false;
}

describe('R3 不泄漏 runLlm(传递依赖与 re-export)', () => {
  it('src/ 里除 backends/ 与 llm-exec 自己外,没有任何文件引用 llm-exec(import / export-from / 动态 import / require)', async () => {
    const files = await walk(SRC);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      if (f === LLM_EXEC || f.startsWith(BACKENDS)) continue;
      const code = stripComments(await readText(f));
      if (LLM_SPECIFIER.test(code)) offenders.push(path.relative(REPO_ROOT, f));
    }
    expect(offenders).toEqual([]);
    // 正向控制:backends 里确实有文件引用它(扫描规则不是空的)
    const inBackends = await walk(BACKENDS);
    let hits = 0;
    for (const f of inBackends) if (LLM_SPECIFIER.test(stripComments(await readText(f)))) hits++;
    expect(hits).toBeGreaterThan(0);
  });

  it('src/reflect/ 下 backends/ 之外的文件(含 index.ts 之类的聚合文件)既不 import 也不 re-export llm-exec', async () => {
    const files = (await walk(path.join(SRC, 'reflect'))).filter((f) => !f.startsWith(BACKENDS));
    expect(files.length).toBeGreaterThan(0); // 至少有 backend-iface.ts
    for (const f of files) {
      expect(LLM_SPECIFIER.test(stripComments(await readText(f))), f).toBe(false);
    }
  });

  it('backends/ 各文件的源码里没有对 llm-exec 的 re-export(export * / export {…} from / export default)', async () => {
    for (const f of await walk(BACKENDS)) {
      const code = stripComments(await readText(f));
      expect(code, f).not.toMatch(/export\s*\*\s*(as\s+\w+\s+)?from\s*['"][^'"]*llm-exec/);
      expect(code, f).not.toMatch(/export\s*(type\s*)?\{[^}]*\}\s*from\s*['"][^'"]*llm-exec/);
      expect(code, f).not.toMatch(/export\s+(const|let|var|function|async\s+function)\s+runLlm\b/);
      expect(code, f).not.toMatch(/export\s*\{[^}]*\brunLlm\b/);
      expect(code, f).not.toMatch(/export\s+default\b/);
    }
  });

  it('backends 所有模块的运行期导出(深度遍历)里都拿不到 runLlm;index 也不导出 LlmSpawnBudget / filterLlmEnv 等出口件', () => {
    expect(runLlm.name).toBe('runLlm'); // 正向控制:比较的对象确实是 runLlm
    for (const [name, mod] of Object.entries(MODULES)) {
      expect(containsRunLlm(mod), name).toBe(false);
    }
    expect(containsRunLlm({ nested: { fn: runLlm } })).toBe(true); // 遍历器自检
    const names = Object.keys(indexMod);
    for (const banned of [
      'runLlm',
      'LlmSpawnBudget',
      'filterLlmEnv',
      'llmCwd',
      'LLM_ENV_ALLOW',
      'LlmExecDeniedError',
    ]) {
      expect(names).not.toContain(banned);
    }
    expect(names).toEqual(
      expect.arrayContaining(['buildBackends', 'createSpawnBudget', 'StubBackend']),
    );
  });

  it('backends/ 之外的 src 文件只能 import backends/index(内部模块 cli-common / gate / lock 等不外露)', async () => {
    const internal = /['"][^'"\n]*backends\/(?!index(\.js|\.ts)?['"])[^'"\n]+['"]/;
    for (const f of await walk(SRC)) {
      if (f.startsWith(BACKENDS)) continue;
      expect(internal.test(stripComments(await readText(f))), f).toBe(false);
    }
    // 规则自检:内部模块的写法会命中
    expect(internal.test(`import { CliBackend } from './backends/cli-common.js';`)).toBe(true);
    expect(internal.test(`import { buildBackends } from './backends/index.js';`)).toBe(false);
    expect(Object.keys(indexMod)).not.toContain('CliBackend');
    expect(Object.keys(indexMod)).not.toContain('serialized');
  });

  it('allowUnverified 只出现在 backends/ 与唯一的接线点 src/commands/reflect.ts 里(judge 等其它文件读不到)', async () => {
    // R5:覆盖层 `reflect.backends[].allow_unverified` 由命令层逐槽位接线进 BackendDeps.allowUnverified。
    // 接线点只有这一个文件;它必须只从覆盖层的 allow_unverified 字段取值,不读环境变量 / 命令行 flag。
    const WIRING = path.join(SRC, 'commands', 'reflect.ts');
    for (const f of await walk(SRC)) {
      if (f.startsWith(BACKENDS) || f === WIRING) continue;
      expect(stripComments(await readText(f)), f).not.toContain('allowUnverified');
    }
    const wiring = stripComments(await readText(WIRING));
    expect(wiring).toContain('allowUnverified');
    expect(wiring).toContain('allow_unverified');
    expect(wiring).not.toMatch(/--allow-unverified|ALLOW_UNVERIFIED|process\.env/);
    // 正向控制
    expect(stripComments(await readText(path.join(BACKENDS, 'cli-common.ts')))).toContain(
      'allowUnverified',
    );
  });

  it('backends 源码(去掉注释后)不含私人账号/渠道/限流钩子路径等写死配置,也不读 HOME', async () => {
    const banned =
      /modelarts|maas_api|MAAS|api\.deepseek|kimi\.com|moonshot\.cn|codex-limited|\.claude\/hooks|\.codex\/|\.pi\/agent|homedir|process\.env/i;
    for (const f of await walk(BACKENDS)) {
      expect(stripComments(await readText(f)), f).not.toMatch(banned);
    }
  });
});

/**
 * D-AU1 / D-AU2(contracts §20.19;评审 H1 / H2-B / M3):钩子入口 import 闭包的新增断言。
 *  - 零网络只读构件(installed / auto-install / signal-code / policy / state)、桥接 self-spawn、钩子入口 hook-entry / poke 的闭包
 *    (含 `import type`,偏保守)不含 net.ts / install.ts / registry / provenance / tar / launcher / home-fs / llm-exec / reflect 后端 / sigstore / 网络模块;
 *  - 这些构件自身没有写类 fs 调用(H2-B:钩子路径零写入);
 *  - 检测器的正向对照:install.ts / launcher.ts 的闭包看得见 net.ts;policy.ts 若重新 `import type` net.ts 就被抓到(H1 的变异锚点)。
 * 本文件只读源码(TypeScript AST),不 import 任何出口。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextSync } from '../../src/io/read-fs.js';
import { ROOT, closureOf, externalSpecs, fsWriteUses, identHits } from '../rsi/closure-util.js';

const FORBIDDEN_FILES = [
  'src/io/net.ts',
  'src/update/install.ts',
  'src/update/launcher.ts',
  'src/update/registry.ts',
  'src/update/provenance.ts',
  'src/update/tar.ts',
  'src/io/home-fs.ts',
  'src/io/llm-exec.ts',
];
const FORBIDDEN_PREFIXES = ['src/reflect/backends/'];
const NET_EXTERNALS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici', 'ws'];

function bad(entries: readonly string[], virtual: Record<string, string> = {}): string[] {
  const c = closureOf(entries, { includeTypes: true, virtual });
  const out: string[] = [];
  for (const f of c.files) {
    if (FORBIDDEN_FILES.includes(f) || FORBIDDEN_PREFIXES.some((p) => f.startsWith(p))) {
      out.push(`file:${f}`);
    }
  }
  for (const e of externalSpecs(c)) {
    const head = e.replace(/^node:/, '').split('/')[0] as string;
    if (NET_EXTERNALS.includes(head) || head === 'sigstore' || e.startsWith('@sigstore/')) {
      out.push(`external:${e}`);
    }
  }
  return out.sort();
}

const ZERO_NET_ENTRIES = [
  'src/update/installed.ts',
  'src/update/auto-install.ts',
  'src/update/signal-code.ts',
  'src/update/policy.ts',
  'src/update/state.ts',
  'src/update/self-spawn.ts',
  'src/rsi/hook-entry.ts',
  'src/rsi/poke.ts',
  'src/io/probe.ts',
];

describe('D-AU:零网络闭包', () => {
  for (const e of ZERO_NET_ENTRIES) {
    it(`${e} 的闭包(含 import type)不含网络出口 / 安装器 / 启动器 / 写出口`, () => {
      const c = closureOf([e], { includeTypes: true });
      expect(c.unresolved).toEqual([]);
      expect(bad([e])).toEqual([]);
    });
  }

  it('self-spawn.ts 的闭包确实走到了新构件(不是空跑):installed / auto-install / policy / io/probe / contracts/net-error', () => {
    const c = closureOf(['src/update/self-spawn.ts'], { includeTypes: true });
    for (const f of [
      'src/update/installed.ts',
      'src/update/auto-install.ts',
      'src/update/policy.ts',
      'src/update/signal-code.ts',
      'src/io/probe.ts',
      'src/io/exec.ts',
    ]) {
      expect(c.files.has(f), f).toBe(true);
    }
    expect(c.files.has('src/io/net.ts')).toBe(false);
  });

  it('hook-entry.ts 经动态 import 到 self-spawn.ts(转发 / 调度的唯一路径),闭包同样干净', () => {
    const c = closureOf(['src/rsi/hook-entry.ts'], { includeTypes: true });
    expect(c.files.has('src/update/self-spawn.ts')).toBe(true);
    expect(c.files.has('src/update/installed.ts')).toBe(true);
    expect(bad(['src/rsi/hook-entry.ts'])).toEqual([]);
  });

  it('H1:policy.ts 引的是 contracts/net-error.ts,不是 io/net.ts;io/net.ts 反向 re-export 码表', () => {
    const policy = readTextSync(path.join(ROOT, 'src/update/policy.ts'));
    expect(policy).toContain("from '../contracts/net-error.js'");
    expect(policy).not.toContain("from '../io/net.js'");
    const net = readTextSync(path.join(ROOT, 'src/io/net.ts'));
    expect(net).toContain("from '../contracts/net-error.js'");
  });
});

describe('D-AU:H2-B 钩子路径只读', () => {
  for (const f of [
    'src/update/installed.ts',
    'src/update/auto-install.ts',
    'src/update/signal-code.ts',
    'src/update/self-spawn.ts',
    'src/io/probe.ts',
  ]) {
    it(`${f} 没有写类 fs 调用`, () => {
      expect(fsWriteUses(f, readTextSync(path.join(ROOT, f)))).toEqual([]);
    });
  }
  it('installed.ts 的标识符里没有 ensureControlledTmp / writeUpdateState / mkdirp / writeFile(创建与写入留在 install.ts;注释不算)', () => {
    const c = closureOf(['src/update/installed.ts']);
    const hits = identHits(c, ['ensureControlledTmp', 'writeUpdateState', 'mkdirp', 'writeFile']);
    expect(hits.filter((h) => h.startsWith('src/update/installed.ts:'))).toEqual([]);
  });
});

describe('检测器正向对照(证明上面的「干净」不是检查器漏看)', () => {
  it('install.ts / launcher.ts 的闭包看得见 net.ts', () => {
    expect(bad(['src/update/install.ts'])).toContain('file:src/io/net.ts');
    expect(bad(['src/update/launcher.ts'])).toContain('file:src/io/net.ts');
    expect(bad(['src/update/launcher.ts'])).toContain('file:src/update/install.ts');
  });
  it('policy.ts 若重新 import type io/net.ts → 闭包立刻含 net.ts(H1 的变异锚点)', () => {
    const src = readTextSync(path.join(ROOT, 'src/update/policy.ts')).replace(
      "from '../contracts/net-error.js'",
      "from '../io/net.js'",
    );
    expect(bad(['src/update/policy.ts'], { 'src/update/policy.ts': src })).toContain(
      'file:src/io/net.ts',
    );
  });
  it('installed.ts 若引入 install.ts / home-fs → 被抓到', () => {
    const src = `${readTextSync(path.join(ROOT, 'src/update/installed.ts'))}\nimport { SHARE_REL as S } from './install.js';\nexport const s = S;\n`;
    const hits = bad(['src/update/installed.ts'], { 'src/update/installed.ts': src });
    expect(hits).toContain('file:src/update/install.ts');
    expect(hits).toContain('file:src/io/net.ts');
    expect(hits).toContain('file:src/io/home-fs.ts');
  });
});

import * as path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { readDir } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const FIXTURES = path.join(REPO_ROOT, 'test/fixtures/lint-violations');

/** 每个故意违规的 fixture 必须被拦,且命中的是预期的规则(不是别的无关错误)。 */
const EXPECTED: Readonly<Record<string, { rule: string; message: string }>> = {
  'child-process-import.ts': { rule: 'no-restricted-imports', message: 'child_process' },
  'constructor-chain.ts': { rule: 'no-restricted-syntax', message: '.constructor' },
  'process-shorthand.ts': { rule: 'no-restricted-syntax', message: '对象简写' },
  'create-require.ts': { rule: 'no-restricted-imports', message: 'node:module' },
  'dynamic-import-data-url.ts': { rule: 'no-restricted-syntax', message: 'data:' },
  'fs-dynamic-import-computed.ts': { rule: 'no-restricted-syntax', message: '字面量' },
  'fs-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '动态 import' },
  'fs-named-import-write.ts': { rule: 'no-restricted-imports', message: 'node:fs' },
  'fs-namespace-import.ts': { rule: 'no-restricted-imports', message: "'fs'" },
  'fs-promises-import.ts': { rule: 'no-restricted-imports', message: 'fs/promises' },
  'global-this-process.ts': { rule: 'no-restricted-syntax', message: 'globalThis' },
  'import-ops.ts': { rule: 'no-restricted-imports', message: 'ops/' },
  'inspector-import.ts': { rule: 'no-restricted-imports', message: 'node:inspector' },
  'llm-exec-import.ts': { rule: 'no-restricted-imports', message: 'llm-exec' },
  'llm-exec-dynamic-import.ts': { rule: 'no-restricted-syntax', message: 'LLM 出口' },
  'llm-exec-reexport.ts': { rule: 'no-restricted-imports', message: 'llm-exec' },
  'network-fetch.ts': { rule: 'no-restricted-globals', message: 'fetch' },
  'os-homedir-import.ts': { rule: 'no-restricted-imports', message: 'node:os' },
  'process-alias.ts': { rule: 'no-restricted-syntax', message: 'process.<成员>' },
  'process-computed-key.ts': { rule: 'no-restricted-syntax', message: '动态键' },
  'process-cwd-read.ts': { rule: 'no-restricted-properties', message: 'process.cwd' },
  'process-destructure.ts': { rule: 'no-restricted-syntax', message: 'process.<成员>' },
  'process-env-read.ts': { rule: 'no-restricted-properties', message: 'process.env' },
  'process-get-builtin-module.ts': {
    rule: 'no-restricted-properties',
    message: 'getBuiltinModule',
  },
  'require-call.ts': { rule: 'no-restricted-syntax', message: 'require' },
  // S0(contracts §19):home-fs / net / launcher / runSelf 的授权闸。样本引用的目标文件 S1/S6/S7 才建,规则按路径模式命中。
  'home-fs-import.ts': { rule: 'no-restricted-imports', message: 'HOME 写出口' },
  'home-fs-reexport.ts': { rule: 'no-restricted-imports', message: 'HOME 写出口' },
  'home-fs-dynamic-import.ts': { rule: 'no-restricted-syntax', message: 'HOME 写出口' },
  // A5(R20-15.6):kit 钩子写出口的授权闸(三种写法各一个反向样本)
  'hooks-fs-import.ts': { rule: 'no-restricted-imports', message: '钩子写出口' },
  'hooks-fs-reexport.ts': { rule: 'no-restricted-imports', message: '钩子写出口' },
  'hooks-fs-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '钩子写出口' },
  // A6(R20-17.20):doctor 直接 import 钩子写出口
  'doctor-hooks-fs-import.ts': { rule: 'no-restricted-imports', message: '钩子写出口' },
  // N4(R20-18.5 / R20-18.25):唯一控制终端出口 src/io/tty.ts 的授权闸(import / re-export / 动态 import / node:tty / /dev/tty 字面量各一个反向样本)
  'tty-import.ts': { rule: 'no-restricted-imports', message: '控制终端出口' },
  'tty-reexport.ts': { rule: 'no-restricted-imports', message: '控制终端出口' },
  'tty-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '控制终端出口' },
  'node-tty-import.ts': { rule: 'no-restricted-imports', message: '控制终端出口' },
  'dev-tty-literal.ts': { rule: 'no-restricted-syntax', message: '字面量只许控制终端出口' },
  'net-import.ts': { rule: 'no-restricted-imports', message: '网络出口' },
  'net-reexport.ts': { rule: 'no-restricted-imports', message: '网络出口' },
  'net-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '网络出口' },
  'https-import.ts': { rule: 'no-restricted-imports', message: 'node:https' },
  'launcher-import.ts': { rule: 'no-restricted-imports', message: '启动器' },
  'launcher-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '启动器' },
  'run-self-import.ts': { rule: 'no-restricted-imports', message: 'runSelf' },
  'run-self-namespace.ts': { rule: 'no-restricted-imports', message: 'runSelf' },
  'run-self-reexport.ts': { rule: 'no-restricted-imports', message: 'runSelf' },
  'run-self-dynamic-import.ts': { rule: 'no-restricted-syntax', message: 'runSelf' },
  // N1 订正 #3(contracts §20.15-12):agent 版本探测出口只许 src/rsi/hooks/**
  'agent-probe-import.ts': { rule: 'no-restricted-imports', message: '版本探测出口' },
  'agent-probe-namespace.ts': { rule: 'no-restricted-imports', message: '版本探测出口' },
  'agent-probe-reexport.ts': { rule: 'no-restricted-imports', message: '版本探测出口' },
  'agent-probe-dynamic-import.ts': { rule: 'no-restricted-syntax', message: '版本探测出口' },
  'sigstore-import.ts': { rule: 'no-restricted-imports', message: 'sigstore' },
  'sigstore-scoped-import.ts': { rule: 'no-restricted-imports', message: 'sigstore' },
  'sigstore-dynamic-import.ts': { rule: 'no-restricted-syntax', message: 'sigstore' },
};

const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
const eslintNormal = new ESLint({ cwd: REPO_ROOT });

describe('lint 反向对照:故意违规的 fixture 必须被拦住', () => {
  it('fixture 目录里的文件与期望表一一对应(不多不少,防止新增违规样本漏登记)', async () => {
    const files = (await readDir(FIXTURES)).filter((e) => e.isFile).map((e) => e.name);
    expect(files.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [file, exp] of Object.entries(EXPECTED)) {
    it(`${file} → ${exp.rule}`, async () => {
      const [res] = await eslint.lintFiles([path.join(FIXTURES, file)]);
      expect(res).toBeDefined();
      const hit = res!.messages.find(
        (m) => m.ruleId === exp.rule && m.message.includes(exp.message),
      );
      expect(hit, JSON.stringify(res!.messages.map((m) => [m.ruleId, m.message]))).toBeDefined();
      expect(res!.messages.some((m) => m.fatal)).toBe(false);
    });
  }

  it('正常 lint(ignore 生效)会跳过该目录:否则 pnpm run lint 会被反向对照打红', async () => {
    const dirty = await eslintNormal.isPathIgnored(path.join(FIXTURES, 'process-env-read.ts'));
    expect(dirty).toBe(true);
  });
});

describe('lint 正向对照:同样的代码放到被授权的文件里不报错', () => {
  const lintAs = async (code: string, rel: string) => {
    const [res] = await eslintNormal.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
    return res!.messages.filter((m) => m.ruleId?.startsWith('no-restricted'));
  };
  const FS = "import * as fs from 'node:fs';\nexport const x = fs.existsSync;\n";
  const OS = "import { homedir } from 'node:os';\nexport const h = homedir;\n";
  const CP = "import { spawnSync } from 'node:child_process';\nexport const s = spawnSync;\n";
  const ENV = "export const h = process.env['HOME'];\nexport const c = process.cwd();\n";

  it('fs 只在 safe-fs.ts / read-fs.ts 放行', async () => {
    expect(await lintAs(FS, 'src/io/safe-fs.ts')).toEqual([]);
    expect(await lintAs(FS, 'src/io/read-fs.ts')).toEqual([]);
    expect((await lintAs(FS, 'src/foo.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'src/io/paths.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'test/x.test.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'adapters/claude/x.ts')).length).toBeGreaterThan(0);
  });

  it('os / process.env / process.cwd 只在 paths.ts 放行', async () => {
    expect(await lintAs(OS, 'src/io/paths.ts')).toEqual([]);
    expect(await lintAs(ENV, 'src/io/paths.ts')).toEqual([]);
    expect((await lintAs(OS, 'src/io/safe-fs.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'src/io/exec.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'src/cli.ts')).length).toBeGreaterThan(0);
  });

  it('N4:控制终端出口 tty.ts 只许 judge-ingest 命令入口 / src/judge/ingest/** / 对应测试引用;node:tty 与控制终端设备字面量只许 tty.ts', async () => {
    const USE = "import { readProof } from '../io/tty.js';\nexport const x = readProof;\n";
    const NODE_TTY = "import * as tty from 'node:tty';\nexport const x = tty.isatty;\n";
    // 本文件自己也受 /dev/tty 字面量闸约束,所以样本代码拼出来
    const LIT = `export const d = '${['', 'dev', 'tty'].join('/')}';\n`;
    for (const ok of [
      'src/commands/judge-ingest.ts',
      'src/judge/ingest/confirm.ts',
      'test/io/tty.test.ts',
      'test/judge/ingest/service.test.ts',
    ]) {
      expect(await lintAs(USE, ok), ok).toEqual([]);
    }
    for (const bad of [
      'src/commands/judge.ts',
      'src/rsi/worker.ts',
      'src/rsi/hint.ts',
      'src/rsi/poke.ts',
      'src/sync/apply.ts',
      'src/update/install.ts',
      'src/judge/run.ts',
    ]) {
      expect((await lintAs(USE, bad)).length, bad).toBeGreaterThan(0);
    }
    expect(await lintAs(NODE_TTY, 'src/io/tty.ts')).toEqual([]);
    expect(await lintAs(LIT, 'src/io/tty.ts')).toEqual([]);
    expect((await lintAs(NODE_TTY, 'src/commands/judge-ingest.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(LIT, 'src/commands/judge-ingest.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(LIT, 'src/judge/ingest/confirm.ts')).length).toBeGreaterThan(0);
  });

  it('child_process 只在 exec.ts 与 llm-exec.ts 放行', async () => {
    expect(await lintAs(CP, 'src/io/exec.ts')).toEqual([]);
    expect(await lintAs(CP, 'src/io/llm-exec.ts')).toEqual([]);
    expect((await lintAs(CP, 'src/reflect/backends/claude.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(CP, 'src/io/read-fs.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(CP, 'src/io/safe-fs.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(CP, 'src/commands/build.ts')).length).toBeGreaterThan(0);
  });

  it('child_process 的测试例外只限登记的子进程黑盒测试文件(K6 override;其余 test/ 文件照拒)', async () => {
    for (const ok of [
      'test/accept/helpers.ts',
      'test/accept/a3.test.ts',
      'test/accept/a15.test.ts',
      'test/accept/p1-ops.test.ts',
      'test/accept/p1-lifecycle-ops.test.ts',
      'test/accept/p1-sync-update-ops.test.ts',
      'test/ops/helpers.ts',
      'test/build/bundle-artifact.test.ts',
    ]) {
      expect(await lintAs(CP, ok), ok).toEqual([]);
    }
    for (const bad of [
      'test/accept/a1.test.ts', // 同目录但未登记
      'test/ops/other.test.ts',
      'test/build/write.test.ts',
      'test/guards/x.test.ts',
    ]) {
      expect((await lintAs(CP, bad)).length, bad).toBeGreaterThan(0);
    }
    // 放行的只有 child_process 的静态 import:同组的 vm / worker_threads / cluster / inspector、动态 import child_process 照旧被拦
    for (const m of ['vm', 'worker_threads', 'cluster', 'inspector']) {
      const code = `import * as m from 'node:${m}';\nexport const x = m;\n`;
      expect((await lintAs(code, 'test/accept/helpers.ts')).length, m).toBeGreaterThan(0);
    }
    const dyn = "export const l = () => import('node:child_process');\n";
    expect((await lintAs(dyn, 'test/ops/helpers.ts')).length).toBeGreaterThan(0);
    // 同一文件里 fs / process.env 照旧被拦
    expect((await lintAs(FS, 'test/accept/helpers.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'test/ops/helpers.ts')).length).toBeGreaterThan(0);
  });

  it('llm-exec 只许 reflect 后端目录与相关测试引用(含 re-export 与动态 import)', async () => {
    const IMP = "import { runLlm } from '../../io/llm-exec.js';\nexport const r = runLlm;\n";
    const REX = "export { runLlm } from '../io/llm-exec.js';\n";
    const PCT = "export const l = () => import('../io/llm%2Dexec.js');\n";
    const DYN = "export const l = () => import('../io/llm-exec.js');\n";
    for (const code of [IMP, REX, DYN]) {
      // 放行位置
      expect(await lintAs(code, 'src/reflect/backends/claude.ts')).toEqual([]);
      expect(await lintAs(code, 'test/io/llm-exec.test.ts')).toEqual([]);
      expect(await lintAs(code, 'test/reflect/backends/claude.test.ts')).toEqual([]);
      // 其余一律拒
      for (const where of [
        'src/reflect/run.ts',
        'src/reflect/prompt/v1.ts',
        'src/reflect/load.ts',
        'src/judge/judge.ts',
        'src/commands/reflect.ts',
        'src/commands/judge.ts',
        'src/io/exec.ts',
        'src/cli.ts',
        'test/reflect/run.test.ts',
        'test/commands/probe.test.ts',
        'adapters/claude/x.ts',
      ]) {
        expect((await lintAs(code, where)).length, `${where}: ${code.trim()}`).toBeGreaterThan(0);
      }
    }
    // %2D 编码绕法:任何位置都拒(含放行位置)
    for (const where of ['src/reflect/backends/claude.ts', 'src/reflect/run.ts']) {
      expect((await lintAs(PCT, where)).length, where).toBeGreaterThan(0);
    }
    // 放行 glob 只给具体测试文件
    expect((await lintAs(IMP, 'test/io/llm-exec-evil.test.ts')).length).toBeGreaterThan(0);
    // 放行位置仍然不能碰 child_process / fs
    expect((await lintAs(CP, 'src/reflect/backends/claude.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(FS, 'src/reflect/backends/claude.ts')).length).toBeGreaterThan(0);
    expect((await lintAs(ENV, 'src/reflect/backends/claude.ts')).length).toBeGreaterThan(0);
  });

  describe('S0:home-fs / net / launcher / runSelf 只放行授权文件', () => {
    const HF_IMP = "import { writeHome } from '../io/home-fs.js';\nexport const w = writeHome;\n";
    const HF_REX = "export { writeHome } from '../io/home-fs.js';\n";
    const HF_DYN = "export const l = () => import('../io/home-fs.js');\n";
    const NET_IMP = "import { httpGet } from '../io/net.js';\nexport const g = httpGet;\n";
    const NET_REX = "export { httpGet } from '../io/net.js';\n";
    const NET_DYN = "export const l = () => import('../io/net.js');\n";
    const LCH_IMP = "import { launch } from './launcher.js';\nexport const g = launch;\n";
    const LCH_DYN = "export const l = () => import('./launcher.js');\n";
    const RS_IMP = "import { runSelf } from '../io/exec.js';\nexport const r = runSelf;\n";
    const RS_NS = "import * as exec from '../io/exec.js';\nexport const r = exec;\n";
    const RS_REX = "export { runSelf } from '../io/exec.js';\n";
    const RS_DYN = "export const l = async () => (await import('../io/exec.js')).runSelf;\n";
    const RUN_SYNC = "import { runSync } from '../io/exec.js';\nexport const r = runSync;\n";
    const FETCH = 'export const g = () => fetch("https://example.invalid");\n';
    const HTTPS = "import { request } from 'node:https';\nexport const r = request;\n";

    const ELSEWHERE = [
      'src/foo.ts',
      'src/commands/sync.ts',
      'src/commands/doctor.ts',
      'src/sync/plan.ts',

      'src/reflect/run.ts',
      'src/io/safe-fs.ts',
      'src/io/exec.ts',
      'adapters/claude/x.ts',
      'test/sync/plan.test.ts',
      'test/foo.test.ts',
    ];

    it('home-fs:只有 sync/apply.ts、update/install.ts 与对应测试能引用(import / re-export / 动态 import)', async () => {
      for (const code of [HF_IMP, HF_REX, HF_DYN]) {
        for (const ok of [
          'src/sync/apply.ts',
          'src/update/install.ts',
          'test/io/home-fs.test.ts',
          'test/io/home-fs-links.test.ts',
          'test/sync/apply.test.ts',
          'test/update/install.test.ts',
        ]) {
          expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
        }
        for (const bad of [
          ...ELSEWHERE,
          'src/sync/txn.ts',
          'src/update/launcher.ts',
          'src/update/provenance.ts',
          'src/update/policy.ts',
          'src/commands/update.ts',
          'test/update/policy.test.ts',
          'test/update/launcher.test.ts',
          'test/sync/apply-evil/x.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
      // home-fs.ts 自己可用 fs(第三个写出口),但不得碰子进程 / 网络 / 环境
      const FS = "import * as fs from 'node:fs';\nexport const x = fs.existsSync;\n";
      expect(await lintAs(FS, 'src/io/home-fs.ts')).toEqual([]);
      expect((await lintAs(HTTPS, 'src/io/home-fs.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FETCH, 'src/io/home-fs.ts')).length).toBeGreaterThan(0);
      // 被授权的使用方仍然不得直接碰 fs
      expect((await lintAs(FS, 'src/sync/apply.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FS, 'src/update/install.ts')).length).toBeGreaterThan(0);
    });

    it('hooks-fs(R20-15.6):只有 src/rsi/hooks/** 与对应测试能引用;sync / update / 自动入口 / §21 目录一律红(import / re-export / 动态 import)', async () => {
      const HK_IMP = "import { HooksFs } from '../io/hooks-fs.js';\nexport const w = HooksFs;\n";
      const HK_REX = "export { HooksFs } from '../io/hooks-fs.js';\n";
      const HK_DYN = "export const l = () => import('../io/hooks-fs.js');\n";
      for (const code of [HK_IMP, HK_REX, HK_DYN]) {
        for (const ok of [
          'src/rsi/hooks/txn.ts',
          'src/rsi/hooks/apply.ts',
          'test/rsi/hooks/a5-txn.test.ts',
          'test/io/hooks-fs.test.ts',
        ]) {
          expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
        }
        for (const bad of [
          ...ELSEWHERE,
          'src/sync/apply.ts',
          'src/update/install.ts',
          'src/update/autosync.ts',
          'src/rsi/poke.ts',
          'src/rsi/hint.ts',
          'src/rsi/worker.ts',
          'src/rsi/kit-schedule.ts',
          'src/rsi/auto/x.ts',
          'src/rsi/capability/x.ts',
          'src/rsi/contrib/x.ts',
          'src/rsi/exec/x.ts',
          'src/commands/rsi.ts',
          'test/rsi/a4-digest.test.ts',
          // A6(R20-17.20):doctor 不得 import hooks-fs;只读出口 hooks-read.ts 自己也不得反向 import 写出口
          'src/doctor/checks.ts',
          'src/doctor/collect.ts',
          'src/doctor/rsi-face.ts',
          'src/commands/doctor.ts',
          'src/io/hooks-read.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
      // hooks-fs.ts 自己可用 fs(第四个写出口),但不得碰子进程 / 网络 / 环境;被授权的使用方仍不得直接碰 fs
      const FS = "import * as fs from 'node:fs';\nexport const x = fs.existsSync;\n";
      expect(await lintAs(FS, 'src/io/hooks-fs.ts')).toEqual([]);
      expect((await lintAs(HTTPS, 'src/io/hooks-fs.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FETCH, 'src/io/hooks-fs.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FS, 'src/rsi/hooks/txn.ts')).length).toBeGreaterThan(0);
      // 反向:src/rsi/hooks/** 不得借此引用 home-fs
      expect((await lintAs(HF_IMP, 'src/rsi/hooks/txn.ts')).length).toBeGreaterThan(0);
      // A6(R20-17.20):只读出口 hooks-read.ts 自己可用 fs(读取),但不得碰子进程 / 网络;doctor 经它读钩子区是允许的
      expect(await lintAs(FS, 'src/io/hooks-read.ts')).toEqual([]);
      expect((await lintAs(HTTPS, 'src/io/hooks-read.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FETCH, 'src/io/hooks-read.ts')).length).toBeGreaterThan(0);
      const HR_IMP =
        "import { HooksRead } from '../io/hooks-read.js';\nexport const r = HooksRead;\n";
      for (const ok of [
        'src/doctor/rsi-face.ts',
        'src/doctor/collect.ts',
        'src/rsi/hooks/inspect.ts',
      ]) {
        expect(await lintAs(HR_IMP, ok), ok).toEqual([]);
      }
      expect((await lintAs(FS, 'src/doctor/rsi-face.ts')).length).toBeGreaterThan(0); // doctor 仍不得直接碰 fs
    });

    it('net:只有 update 模块(launcher 除外)、commands/update.ts 与对应测试能引用;只有 net.ts 能用网络模块 / fetch', async () => {
      for (const code of [NET_IMP, NET_REX, NET_DYN]) {
        for (const ok of [
          'src/update/policy.ts',
          'src/update/install.ts',
          'src/update/provenance.ts',
          'src/commands/update.ts',
          'test/io/net.test.ts',
          'test/io/net-proxy.test.ts',
          'test/update/policy.test.ts',
          'test/update/install.test.ts',
        ]) {
          expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
        }
        for (const bad of [
          ...ELSEWHERE,
          'src/update/launcher.ts',
          'src/sync/apply.ts',
          'src/commands/sync.ts',
          'test/update/launcher.test.ts',
          'test/io/net-evil/x.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
      // net.ts 自己:fetch 与 node:https 放行,fs / child_process / process.env 照旧禁
      expect(await lintAs(FETCH, 'src/io/net.ts')).toEqual([]);
      expect(await lintAs(HTTPS, 'src/io/net.ts')).toEqual([]);
      const FS = "import * as fs from 'node:fs';\nexport const x = fs.existsSync;\n";
      expect((await lintAs(FS, 'src/io/net.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(ENV, 'src/io/net.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(CP, 'src/io/net.ts')).length).toBeGreaterThan(0);
      // 其它位置(含被授权使用方)仍不得直接用 fetch / 网络模块
      for (const where of [
        'src/update/policy.ts',
        'src/update/install.ts',
        'src/commands/update.ts',
      ]) {
        expect((await lintAs(FETCH, where)).length, where).toBeGreaterThan(0);
        expect((await lintAs(HTTPS, where)).length, where).toBeGreaterThan(0);
      }
    });

    it('launcher:只有 cli.ts / src/cli.ts / src/update/** / commands/update.ts 与对应测试能引用', async () => {
      for (const code of [LCH_IMP, LCH_DYN]) {
        for (const ok of [
          'cli.ts',
          'src/cli.ts',
          'src/update/policy.ts',
          'src/update/install.ts',
          'src/commands/update.ts',
          'test/update/policy.test.ts',
          'test/update/launcher.test.ts',
        ]) {
          expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
        }
        for (const bad of [
          'src/foo.ts',
          'src/commands/sync.ts',
          'src/commands/doctor.ts',
          'src/sync/apply.ts',
          'src/reflect/run.ts',
          'src/io/exec.ts',
          'adapters/claude/x.ts',
          'test/foo.test.ts',
          'test/io/net.test.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
    });

    it('runSelf:只有 launcher.ts 与 launcher 测试能引用(命名导入 / import * / re-export),runSync 不受影响', async () => {
      for (const code of [RS_IMP, RS_NS, RS_REX, RS_DYN]) {
        for (const ok of [
          'src/update/launcher.ts',
          'test/update/launcher.test.ts',
          // R20-A0:零网络桥接及其测试(contracts §20.9 第 3 条 ①)
          'src/update/self-spawn.ts',
          'test/update/self-spawn.test.ts',
        ]) {
          expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
        }
        for (const bad of [
          ...ELSEWHERE,
          'src/update/install.ts',
          'src/update/policy.ts',
          'src/cli.ts',
          'cli.ts',
          'src/commands/update.ts',
          // 放行的是具体文件,不是同名前缀 / 相邻目录:rsi 自己的入口也不得直接引用 runSelf,只能经桥接
          'src/update/self-spawn-extra.ts',
          'src/update/self-spawn/inner.ts',
          'src/rsi/poke.ts',
          'src/rsi/worker.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
      // 动态 import llm-exec 的放行位置不被 exec 的动态 import 闸误伤(正向对照)
      expect(
        await lintAs(
          "export const l = () => import('../io/llm-exec.js');\n",
          'src/reflect/backends/claude.ts',
        ),
      ).toEqual([]);
      // 命名导入别的东西不受影响(正向对照:证明上面的拦截确实来自 runSelf 这个名字)
      for (const where of ['src/foo.ts', 'src/update/install.ts', 'src/commands/build.ts']) {
        expect(await lintAs(RUN_SYNC, where), where).toEqual([]);
      }
    });

    it('N1 订正 #3:agent 版本探测出口 src/io/agent-probe.ts 只许 src/rsi/hooks/** 与其测试 import(命名导入 / import * / re-export / 动态 import);它自己可用 child_process 但不得碰 fs / 网络 / 环境', async () => {
      const AP_IMP =
        "import { runAgentVersionCommand } from '../io/agent-probe.js';\nexport const r = runAgentVersionCommand;\n";
      const AP_NS = "import * as probe from '../io/agent-probe.js';\nexport const r = probe;\n";
      const AP_REX = "export { runAgentVersionCommand } from '../io/agent-probe.js';\n";
      const AP_DYN = "export const l = () => import('../io/agent-probe.js');\n";
      for (const code of [AP_IMP, AP_NS, AP_REX, AP_DYN]) {
        // 动态 import 在 src/rsi/hooks/** 里还会被「动态 import 一律禁」的既有闸拦(allowRunSelf 未放行),这里只断言静态三种写法对授权目录放行
        if (code !== AP_DYN) {
          for (const ok of [
            'src/rsi/hooks/agent-version.ts',
            'src/rsi/hooks/command.ts',
            'test/rsi/hooks/a5-pi-version.test.ts',
          ]) {
            expect(await lintAs(code, ok), `${ok}: ${code.trim()}`).toEqual([]);
          }
        }
        for (const bad of [
          ...ELSEWHERE,
          'src/rsi/poke.ts',
          'src/rsi/hint.ts',
          'src/rsi/worker.ts',
          'src/rsi/kit-schedule.ts',
          'src/commands/rsi.ts',
          'src/doctor/checks.ts',
          'src/update/launcher.ts',
          'src/update/self-spawn.ts',
          // 放行的是目录,不是同名前缀:`hooks-x` 不在其内
          'src/rsi/hooks-extra.ts',
          'test/rsi/a4-digest.test.ts',
        ]) {
          expect((await lintAs(code, bad)).length, `${bad}: ${code.trim()}`).toBeGreaterThan(0);
        }
      }
      // 正向对照:授权目录里 import runSync / 别的出口不受这条闸影响;hooks 目录仍不得直接碰 runSelf / 子进程模块
      expect(await lintAs(RUN_SYNC, 'src/rsi/hooks/agent-version.ts')).toEqual([]);
      expect((await lintAs(RS_IMP, 'src/rsi/hooks/agent-version.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(CP, 'src/rsi/hooks/agent-version.ts')).length).toBeGreaterThan(0);
      // agent-probe.ts 自己可用 child_process(第三个出口),但不得碰 fs / 网络;
      expect(await lintAs(CP, 'src/io/agent-probe.ts')).toEqual([]);
      expect((await lintAs(FS, 'src/io/agent-probe.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(HTTPS, 'src/io/agent-probe.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(FETCH, 'src/io/agent-probe.ts')).length).toBeGreaterThan(0);
    });

    it('R20-A0:self-spawn.ts 只比默认多放行 runSelf —— 不得引用 net / home-fs / 启动器 / sigstore / llm-exec / fs / 子进程模块(R20-1.1 零网络)', async () => {
      const SIG = "import { verify } from 'sigstore';\nexport const v = verify;\n";
      const LLM = "import { runLlm } from '../io/llm-exec.js';\nexport const r = runLlm;\n";
      const FS = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
      const CP = "import { spawn } from 'node:child_process';\nexport const s = spawn;\n";
      const ENV = 'export const e = process.env;\n';
      for (const [name, code] of Object.entries({
        net: NET_IMP,
        netRex: NET_REX,
        netDyn: NET_DYN,
        homeFs: HF_IMP,
        homeFsDyn: HF_DYN,
        launcher: LCH_IMP,
        launcherDyn: LCH_DYN,
        sigstore: SIG,
        llm: LLM,
        fs: FS,
        cp: CP,
        env: ENV,
        fetch: FETCH,
        https: HTTPS,
      })) {
        for (const where of ['src/update/self-spawn.ts', 'test/update/self-spawn.test.ts']) {
          expect((await lintAs(code, where)).length, `${where}: ${name}`).toBeGreaterThan(0);
        }
      }
      // 正向对照:同一个文件只引用 runSelf / runSync 与类型是干净的
      expect(await lintAs(RS_IMP, 'src/update/self-spawn.ts')).toEqual([]);
      expect(await lintAs(RUN_SYNC, 'src/update/self-spawn.ts')).toEqual([]);
      // 这种收窄只落在桥接文件上:src/update/** 的其它文件对 net 的既有放行不变
      expect(await lintAs(NET_IMP, 'src/update/policy.ts')).toEqual([]);
    });

    it('launcher.ts 本身不得引用 net / home-fs(最小权限)', async () => {
      expect((await lintAs(NET_IMP, 'src/update/launcher.ts')).length).toBeGreaterThan(0);
      expect((await lintAs(HF_IMP, 'src/update/launcher.ts')).length).toBeGreaterThan(0);
    });
  });

  it('process.stdout / process.argv / process.exitCode 这类无害用法不被误杀', async () => {
    const ok =
      'process.stdout.write("x");\nexport const a = process.argv;\nprocess.exitCode = 0;\n';
    expect(await lintAs(ok, 'src/foo.ts')).toEqual([]);
  });

  it('现有 src / adapters / cli.ts / test 的 lint 全绿(且确实检查了文件)', async () => {
    const results = await eslintNormal.lintFiles(['cli.ts', 'src', 'adapters', 'test']);
    expect(results.length).toBeGreaterThan(20);
    const errors = results.flatMap((r) =>
      r.messages
        .filter((m) => m.severity === 2)
        .map((m) => `${r.filePath}: ${m.ruleId} ${m.message}`),
    );
    expect(errors).toEqual([]);
    // 全仓 lint 在机器忙时可能超过默认 20s;这里不是性能用例,给足时间。
  }, 120_000);
});

/**
 * A5(`rsi hooks`)测试夹具:假 HOME(KIT_TMP 下,经 `KIT_REAL_HOME_OVERRIDE` 注入)、可注入时钟 / 随机源 / 故障点 / 形状表。
 * **所有写都落在假 HOME 内**:每个命令的写审计钩子都被收集,`assertAuditInside` 断言审计里的每个绝对路径都在假 HOME 之内。
 * 测试用形状表 {@link TEST_SHAPES} 把三家的证据级别抬到 `公开文档`(只在测试里;生产表 claude / codex 是 `假设`、pi 是 `实测运行` 且要求版本 >=1.5.0)走写路径。
 * 文件写入只经 safe-fs(`wideCtx(dir)`),不 import node:fs。
 */
import * as path from 'node:path';
import { expect } from 'vitest';
import {
  PRODUCTION_SHAPES,
  type HookShape,
  type ShapeTable,
} from '../../../src/contracts/rsi-hooks.js';
import { RSI_AGENT_IDS, type RsiAgentId } from '../../../src/contracts/rsi.js';
import { exists, lstat, readBytes, readDir, readText } from '../../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { runHooksCommand, type HooksDeps } from '../../../src/rsi/hooks/command.js';
import { sha256Hex } from '../../../src/rsi/hooks/entries.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { makeTempDir, wideCtx } from '../../helpers/tmp.js';
import { withWriteAudit } from '../../helpers/write-audit.js';
import { treeOf } from '../rsi-fixture.js';

const verified = (s: HookShape): HookShape => ({
  ...s,
  evidence: '公开文档',
  agent_versions: null,
});
/** 测试专用:三家都「已核实」(且无版本范围)。生产形状表 {@link PRODUCTION_SHAPES} 里 claude / codex 是 `假设`,pi 要版本 >=1.5.0 */
export const TEST_SHAPES: ShapeTable = {
  claude: verified(PRODUCTION_SHAPES.claude),
  codex: verified(PRODUCTION_SHAPES.codex),
  pi: verified(PRODUCTION_SHAPES.pi),
};

/** 故障注入点抛出的哨兵:模拟进程在该点崩溃(之后再跑一次命令 = 「新进程」恢复) */
export class Crash extends Error {}

export interface R {
  code: number;
  out: string;
  err: string;
  /** 本次调用的写审计 */
  audit: { op: string; path: string }[];
  /** 本次调用的 HooksFs trace(fsync / rename 等顺序) */
  trace: string[];
  /** 本次调用里故障注入点是否触发 */
  crashed: boolean;
}

export interface RunOpts {
  tty?: boolean;
  /** 确认输入;`undefined` = EOF */
  line?: string | undefined;
  deps?: HooksDeps;
  shapes?: ShapeTable;
  /** 本次调用额外的环境变量(例如 `PI_CODING_AGENT_DIR`) */
  envExtra?: Record<string, string>;
  /** 在该注入点抛 {@link Crash} */
  crashAt?: string;
  /** 注入点名单(按触发顺序记录) */
  points?: string[];
}

export const STATE_REL = '.local/state/agent-kit/hooks';

export interface Hx {
  dir: string;
  home: string;
  env: Record<string, string>;
  /** 历次命令的全部审计(累计) */
  allAudit: { op: string; path: string }[];
  run(argv: string[], o?: RunOpts): Promise<R>;
  /** 带 `--write` 的 TTY 确认运行 */
  write(argv: string[], o?: RunOpts): Promise<R>;
  abs(rel: string): string;
  put(rel: string, data: string | Uint8Array, mode?: number): Promise<void>;
  mkdir(rel: string, mode?: number): Promise<void>;
  agentRoot(agent: RsiAgentId): Promise<void>;
  read(rel: string): Promise<string>;
  readB(rel: string): Promise<Buffer>;
  has(rel: string): Promise<boolean>;
  rm(rel: string): Promise<void>;
  link(target: string, rel: string): Promise<void>;
  hard(existingRel: string, rel: string): Promise<void>;
  chmod(rel: string, mode: number): Promise<void>;
  names(subRel: string): Promise<string[]>;
  ledger(): Promise<Record<string, unknown> | null>;
  journals(): Promise<string[]>;
  backups(): Promise<string[]>;
  tree(): Promise<string[]>;
  setNow(d: Date): void;
  /** 断言全部写审计的绝对路径都在假 HOME 内(真实 HOME 不被写) */
  assertAuditInside(): void;
}

export async function makeHx(prefix: string): Promise<Hx> {
  const { dir } = await makeTempDir(prefix);
  const wctx = wideCtx(dir);
  const home = path.join(dir, 'home');
  await mkdirp(wctx, home, 0o755);
  await chmod(wctx, home, 0o755);
  const env = { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: home, KIT_TMP: dir };
  const allAudit: { op: string; path: string }[] = [];
  let tick = 0;
  let base = Date.UTC(2026, 10, 2, 12, 0, 0);
  let seq = 0;
  const abs = (rel: string): string => path.join(home, ...rel.split('/'));

  const mkdir = async (rel: string, mode = 0o755): Promise<void> => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = abs(parts.slice(0, i).join('/'));
      if (!(await exists(p))) {
        await mkdirp(wctx, p, mode);
        await chmod(wctx, p, mode);
      }
    }
  };

  const run = async (argv: string[], o: RunOpts = {}): Promise<R> => {
    const a = withWriteAudit();
    const trace: string[] = [];
    let out = '';
    let err = '';
    let crashed = false;
    const deps: HooksDeps = {
      shapes: o.shapes ?? TEST_SHAPES,
      now: () => new Date(base + tick++ * 1000),
      randomHex: (n) => (++seq).toString(16).padStart(n * 2, '0'),
      trace: (e) => trace.push(e),
      inject: async (p) => {
        o.points?.push(p);
        if (o.crashAt === p) {
          crashed = true;
          throw new Crash(p);
        }
      },
      ...o.deps,
    };
    const ctx: RsiEarlyContext = {
      argv,
      overlayPath: undefined,
      explicitRoot: undefined,
      env: { ...env, ...(o.envExtra ?? {}) },
      writeAudit: a.hook,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      isTty: o.tty ?? false,
      readLine: async () => o.line,
    };
    const code = await runHooksCommand(ctx, deps);
    allAudit.push(...a.calls);
    return { code, out, err, audit: a.calls, trace, crashed };
  };

  const listNames = async (rel: string): Promise<string[]> => {
    try {
      return (await readDir(abs(rel))).map((e) => e.name).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  };

  return {
    dir,
    home,
    env,
    allAudit,
    run,
    write: (argv, o = {}) => run([...argv, '--write'], { tty: true, line: 'yes', ...o }),
    abs,
    mkdir,
    async put(rel, data, mode = 0o600) {
      const parent = rel.split('/').slice(0, -1).join('/');
      if (parent !== '') await mkdir(parent);
      await writeFile(wctx, abs(rel), data, { mode });
      await chmod(wctx, abs(rel), mode);
    },
    async agentRoot(agent) {
      await mkdir(agent === 'pi' ? '.pi/agent' : `.${agent}`);
    },
    read: (rel) => readText(abs(rel)),
    readB: async (rel) => Buffer.from(await readBytes(abs(rel))),
    has: (rel) => exists(abs(rel)),
    rm: (rel) => remove(wctx, abs(rel)),
    link: (target, rel) => symlink(wctx, abs(target), abs(rel)),
    hard: (existingRel, rel) => hardlink(wctx, abs(existingRel), abs(rel)),
    chmod: (rel, mode) => chmod(wctx, abs(rel), mode),
    names: listNames,
    async ledger() {
      const p = `${STATE_REL}/ledger.json`;
      return (await exists(abs(p)))
        ? (JSON.parse(await readText(abs(p))) as Record<string, unknown>)
        : null;
    },
    async journals() {
      return (await listNames(`${STATE_REL}/txn`))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5));
    },
    backups: () => listNames(`${STATE_REL}/backups`),
    tree: () => treeOf(home),
    setNow(d) {
      base = d.getTime();
      tick = 0;
    },
    assertAuditInside() {
      for (const c of allAudit) {
        expect(
          c.path.startsWith(`${home}${path.sep}`) || c.path === home,
          `${c.op} ${c.path}`,
        ).toBe(true);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 常用文本
// ---------------------------------------------------------------------------
export const SENTINEL = 'SENTINEL-5c0ffee-user-config-value';

/** 规范格式的 JSON 文本(2 空格缩进;可选末尾换行) */
export function canon(doc: unknown, trailingNewline = true): string {
  return `${JSON.stringify(doc, null, 2)}${trailingNewline ? '\n' : ''}`;
}

/** 用户自己的非 kit 钩子包装对象 */
export const USER_WRAPPER = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/local/bin/user-audit --quiet', timeout: 10 }],
};

/** 一份含用户内容的规范 claude settings(含哨兵) */
export function userSettings(): string {
  return canon({
    model: 'opus',
    env: { SOME_USER_SETTING: SENTINEL },
    hooks: { PreToolUse: [USER_WRAPPER] },
    permissions: { allow: ['Bash(ls:*)'] },
  });
}

/** 取 `--json` 输出 */
export function jsonOf(r: R): Record<string, unknown> {
  return JSON.parse(r.out) as Record<string, unknown>;
}

export const sha = sha256Hex;
export const AGENTS = RSI_AGENT_IDS;
export { lstat, treeOf };

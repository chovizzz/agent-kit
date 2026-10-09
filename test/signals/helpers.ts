import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createIoContext, getRealHome } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readBytes, readDir, readText } from '../../src/io/read-fs.js';
import { createSignalsCollectCommand } from '../../src/commands/signals-collect.js';
import {
  buildSeeds,
  createRedactor,
  SELFTEST_CONFIG,
  SELFTEST_INTERNAL_DOMAINS,
} from '../../src/redact/index.js';
import type { Seed } from '../../src/redact/index.js';
import { ReferenceClaudeReader } from '../fixtures/sessions/reference-reader.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';
import { writeFile } from '../../src/io/safe-fs.js';

export { REPO_ROOT };

export interface Work {
  dir: string;
  /** 写入根 = dir;stateDir = dir/state */
  io: IoContext;
  sessions: string;
  state: string;
}

/** 唯一工作目录:KIT_TMP(或 .state/test-tmp)下;state 与会话目录都在其内。 */
export async function newWork(prefix: string): Promise<Work> {
  const { dir } = await makeTempDir(prefix);
  const state = path.join(dir, 'state');
  const io = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  return { dir, io, sessions: path.join(dir, 'sessions'), state };
}

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readBytes(file))
    .digest('hex');
}

/**
 * 活机器上会自己增删的顶层条目(Claude Code 的锁文件、shell 补全缓存、历史、回收站等):
 * 它们不是被测代码写的,计入快照会让守卫随机误红。
 */
const LIVE_NOISE =
  /(\.lock$|^\.claude\.json|^\.zcompdump|^\.zsh_(history|sessions)$|^\.DS_Store$|^\.Trash$|^\.viminfo$|^\.lesshst$)/;

/**
 * 真实 HOME 的轻量快照:顶层条目名(去掉活机器噪声)。只读,不碰任何配置文件。
 * 不含 HOME 目录自身的 mtime:任何进程在顶层增删一个条目它都会变,与被测代码无关。
 */
export async function homeSnapshot(): Promise<string> {
  const home = getRealHome();
  const names = (await readDir(home)).map((e) => e.name).filter((n) => !LIVE_NOISE.test(n));
  return JSON.stringify({ names });
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export async function runCollect(
  w: Work,
  argv: string[],
  opts: { overlayPath?: string } = {},
): Promise<RunResult> {
  let out = '';
  let err = '';
  const cmd = createSignalsCollectCommand({
    readers: { claude: () => new ReferenceClaudeReader() },
  });
  const code = await cmd.run({
    argv,
    io: w.io,
    overlayPath: opts.overlayPath,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

export async function writeOverlay(w: Work, toml: string): Promise<string> {
  const file = path.join(w.dir, 'overlay.toml');
  await writeFile(w.io, file, toml);
  return file;
}

/** 命令使用的脱敏配置(覆盖层 TOML):与种子集自检的敏感词/内部域名一致。 */
export function selftestOverlayToml(extra = ''): string {
  return [
    `sensitive_words = ${JSON.stringify(SELFTEST_CONFIG.sensitive_words)}`,
    `internal_domains = ${JSON.stringify([...SELFTEST_INTERNAL_DOMAINS])}`,
    extra,
  ].join('\n');
}

/**
 * 在**命令实际使用的配置**下能被识别并替换的种子(有 needles)。
 * 种子集自检用的是更宽的配置(额外前缀、允许名单),不过滤会让端到端测试因配置差异而假红。
 */
export function recognizedSeeds(): Seed[] {
  const r = createRedactor(
    { sensitive_words: [...SELFTEST_CONFIG.sensitive_words] },
    { internalDomains: SELFTEST_INTERNAL_DOMAINS },
  );
  return buildSeeds().filter((s) => {
    if (s.tier !== 'recognized' || s.needles.length === 0) return false;
    const res = r.apply(s.input);
    return res.ok && s.needles.every((n) => !res.text.includes(n));
  });
}

/** 递归读出 dir 下所有文件的文本(含名字),用于「输出里不得出现 X」的扫描。 */
export async function allFilesText(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  if (!(await exists(dir))) return out;
  for (const e of await readDir(dir)) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await allFilesText(abs)));
    else if (e.isFile) out.push({ file: abs, text: await readText(abs) });
  }
  return out;
}

/** pass2_only 种子:第一遍漏、第二遍抓 → Redactor.apply fail-closed。 */
export function failClosedSeed(): Seed {
  const s = buildSeeds().find((x) => x.tier === 'pass2_only');
  if (!s) throw new Error('种子集里没有 pass2_only 种子');
  return s;
}

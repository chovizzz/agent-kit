// A5 零写入验收编排(由 ops/zero-write-check.sh 调用)。
//
// 主判据:在临时假 HOME 里、`env -i` 等价的干净环境下跑 P0 运行期命令(build/check/redact/signals,不含 inventory),
//         跑完假 HOME 必须为空(例外在 ops/lib/fake-home-allow.txt 明列),同时设 KIT_WRITE_ROOTS 作双保险;
//         仓库内 git status(过滤 .state/、out/)前后不得有变化。
// 副判据:受管路径白名单快照,只在本次运行的开头与结尾做;有差异 => 再整体跑第二轮;
//         归因只看 ctime(inode 变更时间,utimes 改不了、rename 会更新)是否落在命令运行区间内。
// 清单卫生:先静态拒绝「managed 路径被 volatile 覆盖」,有基线(git ref)时还拒绝「managed 行被删/挪进 volatile」。
//
// 退出码:0 通过 / 1 违规 / 2 用法 / 3 清单变更被拒(fail-closed) / 4 未执行 / 5 待人工归因。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compareWithBase,
  findListConflicts,
  gitShow,
  gitStatusPorcelain,
  parseList,
  compileEntry,
} from './lists.mjs';
import {
  diffSnapshots,
  findUncoveredAdapterTargets,
  readAdapterTargets,
  resolveHome,
  takeSnapshot,
} from './snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, '..', '..');
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, LISTS_REJECTED: 3, NOT_RUN: 4, ATTRIBUTE: 5 };

/** P0 运行期命令(inventory 是 stub,不在零写入验证对象内)。 */
export const DEFAULT_COMMANDS = [
  '{NODE} {REPO}/dist/cli.js --root {REPO} build',
  '{NODE} {REPO}/dist/cli.js --root {REPO} check',
  '{NODE} {REPO}/dist/cli.js --root {REPO} redact --selftest',
  '{NODE} {REPO}/dist/cli.js --root {REPO} signals collect --source {SOURCE} --dry',
].join('\n');

const SETTLE_AFTER_MS = 800;
const ALLOWED_EXIT = new Set([0, 64]); // 64 = P0 里尚未实现的命令桩

class UsageError extends Error {}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseArgs(argv) {
  const o = {
    repo: DEFAULT_REPO,
    home: undefined,
    managed: undefined,
    volatile: undefined,
    allowFile: undefined,
    commandsFile: undefined,
    source: undefined,
    baseRef: 'HEAD',
    outRoot: undefined,
    tmp: undefined,
    node: process.execPath,
    noNet: false,
    requireSuccess: false,
    requireCleanTree: false,
    allowKitPaths: false,
    allowManagedRemoval: false,
    noHomeWatch: false,
    twoRounds: false,
    settleMs: SETTLE_AFTER_MS,
    kitName: 'agent-kit',
    selftest: false,
    help: false,
  };
  const val = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] =
      a.startsWith('--') && a.includes('=')
        ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
        : [a, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const v = val(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--repo':
        o.repo = path.resolve(take());
        break;
      case '--home':
        o.home = take();
        break;
      case '--managed':
        o.managed = path.resolve(take());
        break;
      case '--volatile':
        o.volatile = path.resolve(take());
        break;
      case '--allow-file':
        o.allowFile = path.resolve(take());
        break;
      case '--commands-file':
        o.commandsFile = path.resolve(take());
        break;
      case '--source':
        o.source = path.resolve(take());
        break;
      case '--base-ref':
        o.baseRef = take();
        break;
      case '--out-root':
        o.outRoot = path.resolve(take());
        break;
      case '--tmp':
        o.tmp = path.resolve(take());
        break;
      case '--node':
        o.node = path.resolve(take());
        break;
      case '--kit-name':
        o.kitName = take();
        break;
      case '--no-net':
        o.noNet = true;
        break;
      case '--require-success':
        o.requireSuccess = true;
        break;
      case '--require-clean-tree':
        o.requireCleanTree = true;
        break;
      case '--allow-kit-paths-present':
        o.allowKitPaths = true;
        break;
      case '--two-rounds':
        o.twoRounds = true;
        break;
      case '--settle-ms': {
        // 只收十进制非负整数(与 src/commands/args.ts 的 parseDecimalUint 同规则):空串 / 0x / 1e3 / 符号 / 小数一律拒
        const raw = take();
        const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(n) || n > 600_000)
          throw new UsageError('--settle-ms 需要 0..600000 的十进制整数');
        o.settleMs = n;
        break;
      }
      case '--no-home-watch':
        o.noHomeWatch = true;
        break;
      case '--allow-managed-removal':
        o.allowManagedRemoval = true;
        break;
      case '--selftest':
        o.selftest = true;
        break;
      case '--help':
      case '-h':
        o.help = true;
        break;
      default:
        throw new UsageError(`未知参数:${a}`);
    }
  }
  return o;
}

export const HELP = `用法:ops/zero-write-check.sh [选项]
  --selftest                 检测器自检(全部在临时目录里,不碰真实 HOME);退出 0 = 全部预期成立
  --source <目录>            signals collect 的 --source(只读);缺省 = 一个空的合成目录
  --base-ref <ref>           清单基线(默认 HEAD);基线里的 managed 行被删/挪进 volatile => 拒绝
  --allow-managed-removal    允许基线 managed 行被单纯删除(挪进 volatile 永远不允许)
  --commands-file <文件>     覆盖命令清单(每行一条;占位符 {NODE} {REPO} {SOURCE} {HOME} {REALHOME} {TMP})
  --no-net                   给被测命令加 NODE_OPTIONS=--require ops/guards/no-net.cjs
  --require-success          被测命令必须全部退出 0(默认接受 0 和 64=未实现桩)
  --require-clean-tree       开跑前工作树(过滤 .state/ out/)必须干净;默认只要求前后一致
  --two-rounds               无差异时也整体跑第二轮(抓只在第二次调用才写的命令);验收时建议开
  --settle-ms <n>            最后一轮结束后静置 n 毫秒再复查一次受管路径与假 HOME(默认 800;抓 detached 后台进程的延迟写入)
  --no-home-watch            关闭 HOME 顶层/.config/.local 子项名字表的额外监视(默认开)
  --allow-kit-paths-present  允许 ~/.config/<kit>/ 与 ~/.local/state/<kit>/ 事先存在
  --home <目录>              受管路径快照所用的"真实 HOME"(缺省 KIT_REAL_HOME_OVERRIDE,再缺省 os.homedir())
  --repo --managed --volatile --allow-file --out-root --tmp --node --kit-name  路径/名称覆盖
退出码:0 通过 | 1 违规 | 2 用法 | 3 清单变更被拒 | 4 未执行 | 5 待人工归因`;

// ---------- 清单加载与卫生 ----------
export function loadLists(o, home) {
  const managedFile = o.managed ?? path.join(o.repo, 'ops', 'managed-paths.txt');
  const volatileFile = o.volatile ?? path.join(o.repo, 'ops', 'volatile-paths.txt');
  const managedText = readText(managedFile);
  const volatileText = readText(volatileFile);
  const { targets, skipped } = readAdapterTargets(o.repo);
  return {
    managedFile,
    volatileFile,
    managedText,
    volatileText,
    adapterTargets: targets,
    adapterSkipped: skipped,
    homeWatch: !o.noHomeWatch,
    home,
  };
}

/** 返回 [{code,…}];非空 => 退出 3。 */
export function checkLists(o, lists) {
  const problems = [];
  const managed = parseList(lists.managedText);
  const volatile = parseList(lists.volatileText);
  const adapterEntries = lists.adapterTargets.flatMap((t) => parseList(t));
  problems.push(...findListConflicts([...managed, ...adapterEntries], volatile, lists.home));
  // 基线比较:仅当两份清单在默认位置(仓库内)时才有意义
  const rel = path.relative(o.repo, lists.managedFile);
  if (o.baseRef && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const baseText = gitShow(o.repo, o.baseRef, rel.split(path.sep).join('/'));
    if (baseText === null)
      lists.baselineNote = `基线 ${o.baseRef} 里没有 ${rel}(或不是 git 仓库):未做基线比较`;
    const baseVolText = gitShow(
      o.repo,
      o.baseRef,
      path.relative(o.repo, lists.volatileFile).split(path.sep).join('/'),
    );
    for (const p of compareWithBase(
      baseText,
      lists.managedText,
      lists.volatileText,
      lists.home,
      baseVolText,
    )) {
      if (p.code === 'MANAGED_REMOVED' && o.allowManagedRemoval) continue;
      problems.push(p);
    }
  } else if (o.baseRef) lists.baselineNote = '清单不在仓库默认位置(--managed 覆盖):未做基线比较';
  for (const u of findUncoveredAdapterTargets(
    lists.managedText,
    lists.adapterTargets,
    lists.home,
  )) {
    problems.push({ code: 'ADAPTER_TARGET_UNREGISTERED', managed: u });
  }
  return problems;
}

// ---------- 假 HOME 检查 ----------
function walkAll(dir, base, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    out.push(path.relative(base, p));
    if (e.isDirectory() && !e.isSymbolicLink()) walkAll(p, base, out);
  }
}

export function fakeHomeLeftovers(fakeHome, allowText) {
  const all = [];
  walkAll(fakeHome, fakeHome, all);
  const allow = parseList(allowText).map((e) => compileEntry(e, fakeHome));
  return all.filter((rel) => !allow.some((a) => a.covers(path.join(fakeHome, rel)))).sort();
}

// ---------- 单轮 ----------
function buildEnv(o, ctx) {
  const env = {
    PATH: `${path.dirname(o.node)}:/usr/bin:/bin`,
    HOME: ctx.fakeHome,
    TMPDIR: ctx.tmpdir,
    KIT_TMP: ctx.kitTmp,
    KIT_ZW_RUN: ctx.nonce,
    KIT_WRITE_ROOTS: [path.join(o.repo, 'out'), path.join(o.repo, '.state')].join(path.delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'C',
  };
  if (o.noNet) env.NODE_OPTIONS = `--require ${path.join(o.repo, 'ops', 'guards', 'no-net.cjs')}`;
  return env;
}

function expandTokens(line, map) {
  return line.replace(/\{(NODE|REPO|SOURCE|HOME|REALHOME|TMP)\}/g, (_m, k) => map[k]);
}

const filterTree = (l) =>
  (l ?? []).filter((x) => !/^.. (\.state|out)\//.test(x) && !/^\?\? (\.state|out)\//.test(x));

/** 环境里带本次运行 nonce 的存活进程(排除自己)。ps 不可用 / 解析不了 => 空(尽力而为,不是唯一判据)。 */
function findLeftoverProcesses(nonce) {
  const r = spawnSync('/bin/ps', ['-axeww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return null; // 查不了 != 没有残留
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes(`KIT_ZW_RUN=${nonce}`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) out.push(pid);
  }
  return out;
}

function takeSnap(lists) {
  return takeSnapshot({
    home: lists.home,
    managedText: lists.managedText,
    volatileText: lists.volatileText,
    adapterTargets: lists.adapterTargets,
    homeWatch: lists.homeWatch,
  });
}

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runRound(o, ctx, lists, commandsText, roundNo) {
  // 先静置一会儿:开跑前刚发生的写入(含上一轮)的 ctime 要落在本轮窗口(含 PAD)之外
  sleepMs(SETTLE_MS);
  const fakeHome = path.join(ctx.tmpRoot, `home-r${roundNo}`);
  const tmpdir = path.join(ctx.tmpRoot, `tmpdir-r${roundNo}`);
  const kitTmp = path.join(ctx.tmpRoot, `kit-tmp-r${roundNo}`);
  for (const d of [fakeHome, tmpdir, kitTmp]) fs.mkdirSync(d, { recursive: true });
  const rctx = { fakeHome, tmpdir, kitTmp, nonce: ctx.nonce };
  const env = buildEnv(o, rctx);
  const tokenMap = {
    NODE: o.node,
    REPO: o.repo,
    SOURCE: ctx.source,
    HOME: fakeHome,
    REALHOME: lists.home,
    TMP: ctx.tmpRoot,
  };

  const snap = () => takeSnap(lists);
  const gitBefore = gitStatusPorcelain(o.repo);
  const before = snap();
  const start = Date.now();
  const commands = [];
  for (const line of commandsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))) {
    const argv = tokenize(expandTokens(line, tokenMap));
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: o.repo,
      env,
      encoding: 'utf8',
      timeout: 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const abnormal = r.error !== undefined || r.signal !== null;
    commands.push({
      cmd:
        path.basename(argv[0]) +
        ' ' +
        argv
          .slice(1)
          .map((a) => (a.startsWith(o.repo) ? path.relative(o.repo, a) || '.' : a))
          .join(' ')
          .slice(0, 160),
      code: r.status,
      signal: r.signal,
      spawn_error: r.error ? String(r.error.code ?? r.error.message) : undefined,
      stderr_tail:
        (r.status !== null && ALLOWED_EXIT.has(r.status)) || !r.stderr
          ? undefined
          : r.stderr.slice(-300),
      abnormal,
    });
  }
  const after = snap();
  // 窗口末端取「结束快照之后」:命令遗留的后台子进程在快照期间落盘的写入也算在窗口里
  const end = Date.now();
  const gitAfter = gitStatusPorcelain(o.repo);
  const leftovers = fakeHomeLeftovers(fakeHome, lists.allowText);
  const treeBefore = filterTree(gitBefore);
  const treeAfter = filterTree(gitAfter);
  const treeDelta = {
    available: gitBefore !== null && gitAfter !== null,
    dirty_before: treeBefore,
    added: treeAfter.filter((x) => !treeBefore.includes(x)),
    removed: treeBefore.filter((x) => !treeAfter.includes(x)),
  };
  return {
    roundNo,
    fakeHome,
    window: { start, end },
    commands,
    before,
    after,
    diff: diffSnapshots(before, after),
    leftovers,
    treeDelta,
    gitAfterRaw: gitAfter,
  };
}

// ctime 是内核按同一系统时钟打的;留一点点余量即可。余量太大会让两轮窗口重叠、把「只在第一轮写」误判成「每轮都写」。
const PAD_MS = 25;
const SETTLE_MS = 150;
export function ctimeOf(snapshot, p) {
  const m = snapshot.meta[p];
  if (m) return m.ctime_ms;
  if (snapshot.dirs[p] !== undefined) return snapshot.dirs[p];
  // 路径已不存在:一路向上找最近的、快照里记过的祖先目录(整棵子树被删时,直接父目录也不在了;B20 ZW-1)。
  // 祖先目录的 ctime 在删除发生时被内核更新,所以它能代表「删除发生的时间」。
  let cur = p;
  for (let i = 0; i < 64; i++) {
    const parent = cur.replace(/\/[^/]*$/, '');
    if (parent === cur || parent === '') return undefined;
    if (snapshot.dirs[parent] !== undefined) return snapshot.dirs[parent];
    cur = parent;
  }
  return undefined;
}
function inWindow(snapshot, p, w) {
  const c = ctimeOf(snapshot, p);
  return c !== undefined && c >= w.start - PAD_MS && c <= w.end + PAD_MS;
}

function isGlobRec(round, p) {
  return round.after.paths?.[p]?.t === 'glob' || round.before.paths?.[p]?.t === 'glob';
}

const diffPaths = (d) => [...d.added, ...d.removed, ...d.changed].map((x) => x.path);

/**
 * 「内容没变但被碰过」:窗口内 ctime 被更新的受管文件(touch、同内容重写)。
 * 目录记录用 content_ctime_ms(整棵树内文件/链接的最大 ctime,不含目录自身:volatile 子项的增删会抬高目录 ctime,
 * 若计入会误报);子项的增删由 diff 抓。watch:* 名字表不算。(B20 ZW-2:以前目录记录整体被排除,深层文件被碰不可见)
 */
export function touchedPaths(round) {
  const out = [];
  for (const [p, m] of Object.entries(round.after.meta ?? {})) {
    if (p.startsWith('watch:')) continue;
    const rec = round.after.paths?.[p];
    if (!rec || rec.t === 'glob' || rec.t === 'absent') continue;
    const c = m.content_ctime_ms ?? (rec.t === 'dir' ? undefined : m.ctime_ms);
    if (c === undefined) continue;
    if (c >= round.window.start - PAD_MS && c <= round.window.end + PAD_MS) out.push(p);
  }
  return out;
}

/** 单轮的候选路径 = 比对有差异的路径 ∪ 窗口内被碰过的路径。 */
export function candidatePaths(round) {
  return [...new Set([...diffPaths(round.diff), ...touchedPaths(round)])].sort();
}

export function attribute(r1, r2) {
  const d1 = new Set(diffPaths(r1.diff));
  const d2 = new Set(r2 ? diffPaths(r2.diff) : []);
  const paths = [...new Set([...candidatePaths(r1), ...(r2 ? candidatePaths(r2) : [])])].sort();
  return paths.map((p) => {
    const in1 = inWindow(r1.after, p, r1.window);
    const in2 = r2 ? inWindow(r2.after, p, r2.window) : null;
    const reproduced = d1.has(p) && d2.has(p);
    let verdict;
    if (in1 && in2) verdict = 'ours';
    else if (in1 || in2) verdict = 'ambiguous';
    else verdict = reproduced ? 'external-reproduced' : 'external-transient';
    // 前后状态确实不同、却取不到任何 ctime(整棵子树消失且连祖先都没记录):无法归因 => 待人工,绝不当成「外部临时改动」放行
    const noCtime =
      ctimeOf(r1.after, p) === undefined && (!r2 || ctimeOf(r2.after, p) === undefined);
    if (verdict === 'external-transient' && d1.has(p) && noCtime && !isGlobRec(r1, p))
      verdict = 'ambiguous';
    return {
      path: p,
      verdict,
      round2_ran: r2 !== undefined,
      ctime_in_window_r1: in1,
      ctime_in_window_r2: in2,
      reproduced,
      ctime_ms: ctimeOf(r1.after, p) ?? (r2 ? ctimeOf(r2.after, p) : undefined),
    };
  });
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function strip(round) {
  return {
    round: round.roundNo,
    window_ms: round.window,
    commands: round.commands,
    diff: round.diff,
    fake_home_leftovers: round.leftovers,
    git_tree: round.treeDelta,
    stats: round.after.stats,
  };
}

/** 主流程。返回 { exit, report }。 */
export function runZeroWrite(o, log = () => {}) {
  const home = resolveHome(o.home);
  const lists = loadLists(o, home);
  lists.allowText = fs.existsSync(
    o.allowFile ?? path.join(o.repo, 'ops', 'lib', 'fake-home-allow.txt'),
  )
    ? readText(o.allowFile ?? path.join(o.repo, 'ops', 'lib', 'fake-home-allow.txt'))
    : '';
  const report = {
    exit: 0,
    findings: [],
    notes: [],
    lists: {
      adapter_targets: lists.adapterTargets.length,
      adapter_targets_skipped: lists.adapterSkipped,
    },
  };

  const problems = checkLists(o, lists);
  if (problems.length) {
    report.exit = EXIT.LISTS_REJECTED;
    report.findings.push(...problems);
    return { exit: report.exit, report };
  }

  if (lists.baselineNote) report.notes.push(lists.baselineNote);

  const commandsText = o.commandsFile ? readText(o.commandsFile) : DEFAULT_COMMANDS;
  // 零条命令 = 什么都没验证过,不能当通过(B20 ZW-6)
  if (!commandsText.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) {
    report.exit = EXIT.NOT_RUN;
    report.findings.push({ code: 'NO_COMMANDS', detail: '命令清单为空:没有执行任何命令' });
    return { exit: report.exit, report };
  }
  if (!o.commandsFile && !fs.existsSync(path.join(o.repo, 'dist', 'cli.js'))) {
    report.exit = EXIT.NOT_RUN;
    report.findings.push({
      code: 'DIST_MISSING',
      detail: '缺 dist/cli.js:先 pnpm run build(安装与构建在快照之前完成)',
    });
    return { exit: report.exit, report };
  }

  const tmpBase = o.tmp ?? process.env.KIT_TMP ?? os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'zero-write-'));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(o.outRoot ?? path.join(o.repo, '.state', 'zero-write'), ts);
  const source = o.source ?? path.join(tmpRoot, 'source-empty');
  if (!o.source) fs.mkdirSync(source, { recursive: true });
  const ctx = { tmpRoot, source, nonce: crypto.randomBytes(12).toString('hex') };
  report.out_dir = outDir;

  // kit 自己的位置在 P0 必须不存在
  const preSnap = takeSnap(lists);
  const kitKeys = [`~/.config/${o.kitName}`, `~/.local/state/${o.kitName}`];
  const kitPresent = kitKeys.filter((k) => preSnap.paths[k] && preSnap.paths[k].t !== 'absent');
  if (kitPresent.length && !o.allowKitPaths) {
    report.findings.push({ code: 'KIT_PATH_PRESENT_BEFORE', paths: kitPresent });
  }

  const r1 = runRound(o, ctx, lists, commandsText, 1);
  writeJson(path.join(outDir, 'before.json'), r1.before);
  writeJson(path.join(outDir, 'after.json'), r1.after);
  writeJson(path.join(outDir, 'diff.json'), r1.diff);
  report.rounds = [strip(r1)];

  // ---- 主判据 ----
  let hard = report.findings.length > 0;
  if (r1.leftovers.length) {
    hard = true;
    report.findings.push({
      code: 'FAKE_HOME_NOT_EMPTY',
      count: r1.leftovers.length,
      paths: r1.leftovers.slice(0, 50),
    });
  }
  const bad = r1.commands.filter(
    (c) =>
      c.abnormal ||
      c.code === null ||
      (o.requireSuccess ? c.code !== 0 : !ALLOWED_EXIT.has(c.code)),
  );
  if (bad.length) {
    hard = true;
    report.findings.push({ code: 'COMMAND_ABNORMAL_EXIT', commands: bad });
  }
  if (r1.treeDelta.available && (r1.treeDelta.added.length || r1.treeDelta.removed.length)) {
    hard = true;
    report.findings.push({
      code: 'GIT_TREE_CHANGED',
      added: r1.treeDelta.added,
      removed: r1.treeDelta.removed,
    });
  }
  if (r1.treeDelta.available && o.requireCleanTree && r1.treeDelta.dirty_before.length) {
    hard = true;
    report.findings.push({
      code: 'GIT_TREE_DIRTY_BEFORE',
      paths: r1.treeDelta.dirty_before.slice(0, 50),
    });
  }
  if (!r1.treeDelta.available)
    report.notes.push('仓库不是 git 工作树或 git 不可用:跳过 git status 判据');
  else if (r1.treeDelta.dirty_before.length)
    report.notes.push(
      `开跑前工作树非干净(${r1.treeDelta.dirty_before.length} 项):只比较前后差异;验收时用 --require-clean-tree`,
    );

  // ---- 副判据 ----
  let attributions = [];
  let r2;
  const cand1 = candidatePaths(r1);
  if ((cand1.length > 0 || o.twoRounds) && !hard) {
    r2 = runRound(o, ctx, lists, commandsText, 2);
    writeJson(path.join(outDir, 'before2.json'), r2.before);
    writeJson(path.join(outDir, 'after2.json'), r2.after);
    writeJson(path.join(outDir, 'diff2.json'), r2.diff);
    report.rounds.push(strip(r2));
    const bad2 = r2.commands.filter(
      (c) =>
        c.abnormal ||
        c.code === null ||
        (o.requireSuccess ? c.code !== 0 : !ALLOWED_EXIT.has(c.code)),
    );
    if (bad2.length) {
      hard = true;
      report.findings.push({ code: 'COMMAND_ABNORMAL_EXIT', round: 2, commands: bad2 });
    }
    if (r2.treeDelta.available && (r2.treeDelta.added.length || r2.treeDelta.removed.length)) {
      hard = true;
      report.findings.push({
        code: 'GIT_TREE_CHANGED',
        round: 2,
        added: r2.treeDelta.added,
        removed: r2.treeDelta.removed,
      });
    }
    if (r2.leftovers.length) {
      hard = true;
      report.findings.push({
        code: 'FAKE_HOME_NOT_EMPTY',
        round: 2,
        count: r2.leftovers.length,
        paths: r2.leftovers.slice(0, 50),
      });
    }
  }
  if (cand1.length > 0 || (r2 && candidatePaths(r2).length > 0)) {
    attributions = attribute(r1, r2);
    report.attributions = attributions;
  }
  // ---- 全程首尾比对 + 静置复查(B20 ZW-4)----
  // 每轮各比各的前后快照看不到:①两轮之间的写入(落在 r1.after 之后、r2.before 之前);
  // ②最后一轮之后由 detached 后台进程做的延迟写入。所以:最后一轮结束后静置,再取一次终态快照,
  // 并比对「第一轮开始 vs 终态」「各轮之间」「最后一轮结束 vs 终态」。
  const last = r2 ?? r1;
  sleepMs(o.settleMs);
  const finalSnap = takeSnap(lists);
  const roundDiffPaths = new Set([...diffPaths(r1.diff), ...(r2 ? diffPaths(r2.diff) : [])]);
  const gapPaths = r2 ? diffPaths(diffSnapshots(r1.after, r2.before)) : [];
  const latePaths = diffPaths(diffSnapshots(last.after, finalSnap));
  const whole = diffSnapshots(r1.before, finalSnap);
  const unexplained = diffPaths(whole).filter((x) => !roundDiffPaths.has(x));
  report.whole_run = { count: whole.count, paths: diffPaths(whole).slice(0, 50) };
  const outside = [...new Set([...gapPaths, ...latePaths, ...unexplained])].sort();
  let needAttrib = false;
  if (outside.length) {
    needAttrib = true;
    report.findings.push({
      code: 'CHANGE_OUTSIDE_COMMAND_WINDOW',
      detail:
        '受管路径在命令运行区间之外发生变化(两轮之间 / 最后一轮结束后的静置期内):可能是命令遗留的后台进程,也可能是外部进程,需人工归因',
      between_rounds: gapPaths.slice(0, 50),
      after_run: latePaths.slice(0, 50),
      unexplained: unexplained.slice(0, 50),
    });
  }
  for (const rd of [r1, ...(r2 ? [r2] : [])]) {
    const now = fakeHomeLeftovers(rd.fakeHome, lists.allowText);
    if (now.some((x) => !rd.leftovers.includes(x))) {
      hard = true;
      report.findings.push({
        code: 'FAKE_HOME_NOT_EMPTY',
        round: rd.roundNo,
        phase: 'after-settle',
        count: now.length,
        paths: now.slice(0, 50),
      });
    }
  }
  // 命令遗留的后代进程(detached、改了进程组也跑不掉:它们继承了本次运行的 nonce 环境变量):静置后仍活着 => 违规,并清掉
  const scanned = findLeftoverProcesses(ctx.nonce);
  if (scanned === null)
    report.notes.push('ps 不可用或不显示环境:未能做遗留进程扫描(不代表没有残留)');
  const leftoverPids = scanned ?? [];
  if (leftoverPids.length) {
    hard = true;
    report.findings.push({
      code: 'LEFTOVER_PROCESS_AFTER_RUN',
      detail: `命令退出并静置 ${o.settleMs}ms 后仍有 ${leftoverPids.length} 个后代进程存活(已终止)`,
      count: leftoverPids.length,
    });
    for (const pid of leftoverPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  const gitFinal = gitStatusPorcelain(o.repo);
  if (r1.treeDelta.available && gitFinal !== null) {
    const fin = filterTree(gitFinal);
    const lastTree = filterTree(last.gitAfterRaw);
    const a = fin.filter((x) => !lastTree.includes(x));
    const b = lastTree.filter((x) => !fin.includes(x));
    if (a.length || b.length) {
      hard = true;
      report.findings.push({
        code: 'GIT_TREE_CHANGED',
        phase: 'after-settle',
        added: a,
        removed: b,
      });
    }
  }
  const outsideLinks = [
    ...new Set([...preSnap.outside_links, ...r1.after.outside_links, ...finalSnap.outside_links]),
  ].sort();
  if (outsideLinks.length) {
    // 目标内容未读:写入仍会改变目标的 ctime/size(快照有差异,走正常归因);这里只披露盲区,不单独判红
    report.notes.push(
      `${outsideLinks.length} 个受管符号链接指向 HOME 之外(或凭据位置),只比对目标元数据、未读内容:${outsideLinks.slice(0, 10).join(', ')}`,
    );
    report.outside_links = outsideLinks;
  }
  if (r1.after.stats.truncated || finalSnap.stats.truncated) {
    needAttrib = true;
    report.findings.push({
      code: 'SNAPSHOT_TRUNCATED',
      detail:
        '快照里有目录树超过上限(50000 项 / 1GiB 哈希预算)或读不了的子目录:深层变更可能漏检,不能判通过',
    });
  }

  const ours = attributions.filter((a) => a.verdict === 'ours');
  const attribNeeded = attributions.filter(
    (a) => a.verdict === 'ambiguous' || a.verdict === 'external-reproduced',
  );
  const transient = attributions.filter((a) => a.verdict === 'external-transient');
  if (ours.length) {
    hard = true;
    report.findings.push({
      code: 'MANAGED_PATH_WRITTEN_DURING_RUN',
      paths: ours.map((a) => a.path),
    });
  }
  if (transient.length)
    report.notes.push(
      `${transient.length} 个差异只出现一次且 ctime 在命令运行区间之外(疑为外部进程):${transient
        .map((a) => a.path)
        .slice(0, 10)
        .join(', ')}`,
    );

  if (hard) report.exit = EXIT.FAIL;
  else if (attribNeeded.length || needAttrib) {
    report.exit = EXIT.ATTRIBUTE;
    if (attribNeeded.length)
      report.findings.push({ code: 'ATTRIBUTION_REQUIRED', paths: attribNeeded });
  } else report.exit = EXIT.OK;

  report.stats = { ...r1.after.stats, rounds: report.rounds.length };
  writeJson(path.join(outDir, 'report.json'), report);
  log(`报告:${outDir}`);
  // 清理临时目录(其内容已汇总进报告)
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { exit: report.exit, report };
}

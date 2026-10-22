// B18 验收脚本公共库(A1–A15 共用)。ops/ 不受 src/ 的 io 限制约束,但约定:
//  - 只写 $KIT_TMP(缺省 <root>/.state/accept-tmp)与 <root>/.state/accept;
//  - 绝不把"未执行"当"通过":退出码 4 单列;
//  - 子进程一律用白名单 env(默认不带真实 HOME)。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 0=通过 1=违规 2=用法错 3=清单/配置被拒 4=未执行 5=待人工归因(与 ops/lib/zero-write.mjs 同表) */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, REJECTED: 3, NOT_RUN: 4, ATTRIBUTE: 5 };

/** 脚本内合并多个结果时的优先级:3 > 2 > 1 > 4 > 5 > 0(与 docs/contracts.md §2 的"严重在前"同向)。 */
export const PRIORITY = [3, 2, 1, 4, 5, 0];
export function mergeExit(codes) {
  for (const p of PRIORITY) if (codes.includes(p)) return p;
  return EXIT.OK;
}

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..');

export class UsageError extends Error {}

/**
 * 极简参数解析。spec: { bool: [...], value: [...], multi: [...] },名字不带 `--`。
 * 返回 { flags: {name: true|string|string[]}, rest: [] }。未知选项抛 UsageError。
 */
export function parseFlags(argv, spec = {}) {
  const bool = new Set(spec.bool ?? []);
  const value = new Set(spec.value ?? []);
  const multi = new Set(spec.multi ?? []);
  const flags = {};
  for (const m of multi) flags[m] = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (bool.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} 不接受值`);
      flags[name] = true;
    } else if (value.has(name) || multi.has(name)) {
      let v;
      if (eq !== -1) v = a.slice(eq + 1);
      else {
        v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} 需要一个值`);
        i++;
      }
      if (multi.has(name)) flags[name].push(v);
      else flags[name] = v;
    } else throw new UsageError(`未知选项:${a}`);
  }
  return { flags, rest };
}

/** 统一的"通过/违规/未执行"累积器;每条结果打印一行,最后给出本脚本的退出码。 */
export class Reporter {
  constructor(id, out = (s) => process.stdout.write(s + '\n')) {
    this.id = id;
    this.out = out;
    this.codes = [];
    this.counts = { pass: 0, fail: 0, notRun: 0, rejected: 0, attribute: 0 };
  }
  info(msg) {
    this.out(`[${this.id}] ${msg}`);
  }
  pass(msg) {
    this.counts.pass++;
    this.out(`[${this.id}] PASS ${msg}`);
  }
  fail(msg) {
    this.counts.fail++;
    this.codes.push(EXIT.FAIL);
    this.out(`[${this.id}] FAIL ${msg}`);
  }
  notRun(msg) {
    this.counts.notRun++;
    this.codes.push(EXIT.NOT_RUN);
    this.out(`[${this.id}] NOT-RUN ${msg}`);
  }
  rejected(msg) {
    this.counts.rejected++;
    this.codes.push(EXIT.REJECTED);
    this.out(`[${this.id}] REJECTED ${msg}`);
  }
  attribute(msg) {
    this.counts.attribute++;
    this.codes.push(EXIT.ATTRIBUTE);
    this.out(`[${this.id}] ATTRIBUTE ${msg}`);
  }
  usage(msg) {
    this.codes.push(EXIT.USAGE);
    this.out(`[${this.id}] USAGE ${msg}`);
  }
  /** 把某个子检查的退出码并入。 */
  merge(code, msg) {
    if (code === EXIT.OK) this.pass(msg);
    else if (code === EXIT.FAIL) this.fail(msg);
    else if (code === EXIT.NOT_RUN) this.notRun(msg);
    else if (code === EXIT.REJECTED) this.rejected(msg);
    else if (code === EXIT.ATTRIBUTE) this.attribute(msg);
    else this.usage(msg);
  }
  /**
   * 收尾:没有任何一条 PASS 且没有任何非零记录 => 视为"空跑",按 4 处理(防止什么都没检查却返回 0)。
   */
  exit() {
    if (this.codes.length === 0 && this.counts.pass === 0) {
      this.out(`[${this.id}] NOT-RUN 没有执行任何检查`);
      return EXIT.NOT_RUN;
    }
    const code = mergeExit(this.codes);
    this.out(
      `[${this.id}] 结果 exit=${code} (pass=${this.counts.pass} fail=${this.counts.fail} not-run=${this.counts.notRun})`,
    );
    return code;
  }
}

/** 解析仓库根、CLI、node 与临时目录基址。 */
export function makeCtx(flags) {
  const root = path.resolve(flags.root ?? DEFAULT_ROOT);
  const cli = path.resolve(flags.cli ?? path.join(root, 'dist', 'cli.js'));
  const tmpBase = path.resolve(
    process.env.KIT_TMP && process.env.KIT_TMP !== ''
      ? process.env.KIT_TMP
      : // 默认建在仓库**外**:子进程的假 HOME 在这里面,而产品的路径守卫拒绝「仓库根是 HOME 的上级」。
        path.join(fs.realpathSync(os.tmpdir()), 'agent-kit-accept'),
  );
  return { root, cli, tmpBase, node: process.execPath, flags };
}

export function mkTmp(ctx, prefix) {
  fs.mkdirSync(ctx.tmpBase, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(ctx.tmpBase, `${prefix}-`)));
}

/** 子进程沙箱目录:HOME 与 KIT_TMP 必须是同级(KIT_TMP 不得是 HOME 的上级,CLI 会拒绝)。 */
export function sandbox(tmp) {
  const home = path.join(tmp, 'sbx-home');
  const kit = path.join(tmp, 'sbx-kit');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(kit, { recursive: true });
  return { home, kit };
}

/**
 * CLI 编译产物里 src/ 的位置(dist/cli.js => dist/src)。
 * S7b 起发布用的 dist/ 是打包产物、没有 src/;本仓库构建时 tsc 的逐文件产物在 node_modules/.cache/agent-kit-tsc,
 * 所以 <cli 目录>/src 不存在时,退到 <cli 目录的上一级>/node_modules/.cache/agent-kit-tsc/src(找不到就仍返回 <cli 目录>/src)。
 */
export function distSrc(ctx) {
  const beside = path.join(path.dirname(ctx.cli), 'src');
  if (fs.existsSync(beside)) return beside;
  const tsc = path.join(
    path.dirname(path.dirname(ctx.cli)),
    'node_modules',
    '.cache',
    'agent-kit-tsc',
    'src',
  );
  return fs.existsSync(tsc) ? tsc : beside;
}

export function rmTmp(dir) {
  try {
    // 先放开只读副本的权限(A6),再删
    chmodTree(dir, true);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

export function chmodTree(dir, writable) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (writable) fs.chmodSync(dir, st.mode | 0o700);
    for (const n of fs.readdirSync(dir)) chmodTree(path.join(dir, n), writable);
    if (!writable) fs.chmodSync(dir, st.mode & ~0o222);
  } else {
    fs.chmodSync(dir, writable ? st.mode | 0o600 : st.mode & ~0o222);
  }
}

/** 子进程白名单 env:PATH(含当前 node 所在目录)+ 显式给的键。默认不带 HOME。 */
export function cleanEnv(extra = {}) {
  return {
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...extra,
  };
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? cleanEnv(),
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 20 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const spawnFailed = r.error !== undefined && r.status === null && r.signal === null;
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
    // ENOENT 之类:命令根本没起来 => 调用方应判"未执行"
    spawnFailed,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 目录树哈希:排序后的 (相对路径, sha256) 列表再哈希。符号链接记 readlink 目标。 */
export function treeHash(dir) {
  const entries = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort(byteCmp)) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) entries.push(`${r}\tL:${fs.readlinkSync(path.join(dir, r))}`);
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) entries.push(`${r}\t${sha256(fs.readFileSync(path.join(dir, r)))}`);
    }
  };
  walk('');
  entries.sort(byteCmp);
  return { hash: sha256(entries.join('\n')), count: entries.length, entries };
}

export function byteCmp(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** 仓库文件清单:git 仓库用 ls-files(含未跟踪未忽略),否则退化为遍历(排除 node_modules/.git/dist/out/.state)。 */
export function listRepoFiles(root, { exclude = [] } = {}) {
  const isExcluded = (rel) =>
    exclude.some((e) => rel === e || rel.startsWith(e.endsWith('/') ? e : `${e}/`));
  const g = run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
    env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
  });
  let files;
  if (g.status === 0 && fs.existsSync(path.join(root, '.git'))) {
    files = g.stdout.split('\0').filter(Boolean);
  } else {
    files = [];
    const walk = (rel) => {
      for (const n of fs.readdirSync(path.join(root, rel))) {
        const r = rel === '' ? n : `${rel}/${n}`;
        if (['node_modules', '.git', 'dist', 'out', '.state'].includes(n)) continue;
        const st = fs.lstatSync(path.join(root, r));
        if (st.isDirectory()) walk(r);
        else files.push(r);
      }
    };
    walk('');
  }
  return files.filter((f) => !isExcluded(f) && fs.existsSync(path.join(root, f))).sort(byteCmp);
}

export function copyFiles(root, files, dest) {
  for (const rel of files) {
    const from = path.join(root, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 评估 vitest --reporter=json 的结果。skipped / todo 必须为 0(beforeAll 挂掉会显示成 skipped),total 必须 >0。
 * 返回 { ok, problems[], total, passed, failed, pending, todo, titles: [{fullName,status,file}] }
 */
export function evaluateVitest(json) {
  const problems = [];
  const num = (k) => (typeof json?.[k] === 'number' ? json[k] : NaN);
  const total = num('numTotalTests');
  const passed = num('numPassedTests');
  const failed = num('numFailedTests');
  const pending = num('numPendingTests');
  const todo = num('numTodoTests');
  for (const [k, v] of Object.entries({ total, passed, failed, pending, todo })) {
    if (!Number.isFinite(v)) problems.push(`vitest 结果缺字段 ${k}`);
  }
  if (Number.isFinite(total) && total <= 0) problems.push('vitest 一个用例都没跑(total=0)');
  if (failed > 0) problems.push(`失败用例 ${failed}`);
  if (pending > 0) problems.push(`skipped/pending 用例 ${pending}(要求 0)`);
  if (todo > 0) problems.push(`todo 用例 ${todo}(要求 0)`);
  if ((json?.numFailedTestSuites ?? 0) > 0)
    problems.push(`失败的测试文件 ${json.numFailedTestSuites}`);
  if (json?.success === false && problems.length === 0) problems.push('vitest success=false');
  if (
    Number.isFinite(total) &&
    Number.isFinite(passed) &&
    passed !== total - failed - pending - todo
  ) {
    problems.push(
      `用例数对不上:total=${total} passed=${passed} failed=${failed} pending=${pending} todo=${todo}`,
    );
  }
  const titles = [];
  let loadFailures = 0;
  for (const f of json?.testResults ?? []) {
    for (const a of f.assertionResults ?? []) {
      titles.push({
        fullName: String(a.fullName ?? a.title ?? ''),
        status: a.status,
        file: f.name,
      });
    }
    if (f.status === 'failed' && (f.assertionResults ?? []).length === 0) {
      problems.push(`测试文件加载失败:${path.basename(String(f.name))}`);
      loadFailures += 1;
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    total,
    passed,
    failed,
    pending,
    todo,
    loadFailures,
    titles,
  };
}

/**
 * 变异抽检(A20 / A24 / A28 共用)的「红灯」判据:变异后是否出现了**预期的**那条红灯。
 * v 是 runVitest 的返回;redTitles 是该变异预期变红的用例**完整标题**(vitest fullName,整串精确相等,不做子串匹配)。
 * 判红须同时满足:
 *   1. vitest 跑起来了、有结果;
 *   2. 没有 skipped / todo(beforeAll 挂掉会让一批用例变 skipped,红灯可能只是假象)、没有测试文件加载失败(语法错误 / 导入失败);
 *   3. redTitles 里的每一条都真的出现在这次运行里(标题改名后预期陈旧,拒绝,不静默当作没命中);
 *   4. redTitles 里至少一条状态为 failed。
 * 不在 redTitles 里的失败用例是「无关红灯」:不计入、也不否决(一处变异可以连带别的用例变红),但绝不能单独让变异判红。
 * 返回 { red, note, credited[] }。
 */
export function judgeMutationRed(v, redTitles) {
  const ev = v?.evaluation;
  if (
    !Array.isArray(redTitles) ||
    redTitles.length === 0 ||
    redTitles.some((t) => typeof t !== 'string' || t === '')
  )
    return { red: false, note: 'redTitles 必须是非空的完整标题数组', credited: [] };
  if (v.code === EXIT.NOT_RUN || !ev)
    return { red: false, note: `vitest 没跑起来:${v?.why ?? ''}`, credited: [] };
  if (ev.loadFailures > 0)
    return {
      red: false,
      note: `有 ${ev.loadFailures} 个测试文件加载失败,红灯不可信`,
      credited: [],
    };
  if (ev.pending > 0 || ev.todo > 0)
    return {
      red: false,
      note: `变异运行里有 skipped/todo(${ev.pending}/${ev.todo}),红灯不可信`,
      credited: [],
    };
  if (ev.failed === 0) return { red: false, note: '测试仍为绿(变异存活)', credited: [] };
  const status = new Map();
  for (const t of ev.titles) status.set(t.fullName, [...(status.get(t.fullName) ?? []), t.status]);
  const missing = redTitles.filter((t) => !status.has(t));
  if (missing.length > 0)
    return {
      red: false,
      note: `预期标题没有出现在本次运行里(标题改名或测试文件没选上):${missing[0].slice(-40)}`,
      credited: [],
    };
  const credited = redTitles.filter((t) => status.get(t).includes('failed'));
  const failedAll = ev.titles.filter((t) => t.status === 'failed').length;
  if (credited.length === 0)
    return {
      red: false,
      note: `变红了,但预期的那几条用例没有一条变红(${failedAll} 个无关红灯不算数)`,
      credited,
    };
  return {
    red: true,
    note: `${failedAll} 个用例变红,其中预期的 ${credited.length} 条精确命中:${credited
      .slice(0, 2)
      .map((t) => t.slice(-40))
      .join(' | ')}`,
    credited,
  };
}

/**
 * 在 root 里跑 vitest(`<root>/node_modules/.bin/vitest`,可被 flags.vitestBin 覆盖),返回
 * { code, evaluation, raw }。code:0 通过 / 1 有失败 / 4 vitest 没起来或没产出 JSON。
 */
export function runVitest(ctx, tmpDir, files, extraArgs = [], envExtra = {}) {
  const bin = ctx.flags.vitestBin ?? path.join(ctx.root, 'node_modules', '.bin', 'vitest');
  if (!fs.existsSync(bin))
    return { code: EXIT.NOT_RUN, why: `找不到 vitest:${bin}`, evaluation: null };
  const outFile = path.join(tmpDir, `vitest-${sha256(files.join(',')).slice(0, 8)}.json`);
  const r = run(
    bin,
    ['run', ...files, '--reporter=json', `--outputFile=${outFile}`, ...extraArgs],
    {
      cwd: ctx.root,
      env: cleanEnv({ KIT_TMP: tmpDir, CI: '1', ...envExtra }),
    },
  );
  if (r.spawnFailed || !fs.existsSync(outFile)) {
    return {
      code: EXIT.NOT_RUN,
      why: `vitest 没有产出结果文件(exit=${r.status} ${r.signal ?? ''} ${String(r.stderr).slice(0, 200)})`,
      evaluation: null,
    };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { code: EXIT.NOT_RUN, why: 'vitest 结果文件不是合法 JSON', evaluation: null };
  }
  const evaluation = evaluateVitest(json);
  if (r.status === null)
    return { code: EXIT.NOT_RUN, why: `vitest 异常终止(${r.signal ?? '超时'})`, evaluation };
  if (r.status !== 0 && evaluation.ok)
    evaluation.problems.push(`vitest 进程退出 ${r.status}(结果 JSON 全绿也不算通过)`);
  if (r.status !== 0) evaluation.ok = false;
  return {
    code: evaluation.ok ? EXIT.OK : EXIT.FAIL,
    evaluation,
    why: evaluation.problems.join('; '),
  };
}

/** 供各脚本入口复用:包一层捕获 UsageError / 未预期异常(未预期 => 4,不当通过)。 */
export async function main(id, fn) {
  try {
    process.exitCode = await fn();
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`[${id}] 用法错误:${e.message}\n`);
      process.exitCode = EXIT.USAGE;
    } else {
      process.stderr.write(`[${id}] 未预期异常(按未执行处理):${e?.stack ?? e}\n`);
      process.exitCode = EXIT.NOT_RUN;
    }
  }
}

/** 仅当本模块是入口脚本时才运行(让单测可以 import 纯函数)。 */
export async function runMain(metaUrl, id, fn) {
  const self = fs.realpathSync(fileURLToPath(metaUrl));
  let entry = '';
  try {
    entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
  } catch {
    entry = ''; // node -e 的 argv[1] 可能不是文件:此时当作"被 import"
  }
  if (self === entry) await main(id, fn);
}

export const COMMON_FLAGS = { value: ['root', 'cli', 'vitest-bin'], bool: ['help'] };

/** 公共旗标名 camelCase 化,便于 ctx.flags.vitestBin。 */
export function camelFlags(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags))
    out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
}

export function parseCommon(argv, spec = {}) {
  const { flags, rest } = parseFlags(argv, {
    bool: [...COMMON_FLAGS.bool, ...(spec.bool ?? [])],
    value: [...COMMON_FLAGS.value, ...(spec.value ?? [])],
    multi: spec.multi ?? [],
  });
  return { flags: camelFlags(flags), rest };
}

/** 可观察的"命令桩"判定:退出 64 => 未实现 => 调用方按 4(未执行)处理。 */
export const EXIT_STUB = 64;

/** 递归找 *.test.ts(相对 root,正斜杠,排序)。 */
export function listTestFiles(root, dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const n of fs.readdirSync(abs)) {
      const r = `${rel}/${n}`;
      const st = fs.statSync(path.join(root, r));
      if (st.isDirectory()) walk(r);
      else if (n.endsWith('.test.ts')) out.push(r);
    }
  };
  walk(dir.replace(/\/$/, ''));
  return out.sort(byteCmp);
}

export const CONTROL_RE = /正向(控制|对照)|合法对照|positive control/i;

/**
 * 证明"指定的测试文件与关键用例真的执行了"(而不仅是总数>0):
 *  spec.files:  { '<相对路径>': { min: 至少多少通过用例, controls: 至少多少条标题含"正向控制/正向对照"的通过用例 } }
 *  spec.dirs:   这些目录下磁盘上存在的每个 *.test.ts 都必须出现在结果里且至少 1 条通过
 * 返回 problems[]。
 */
export function checkRequiredTests(evaluation, root, spec) {
  const problems = [];
  const byFile = new Map();
  for (const t of evaluation.titles) {
    const rel = path.relative(root, String(t.file)).split(path.sep).join('/');
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(t);
  }
  const need = { ...(spec.files ?? {}) };
  for (const d of spec.dirs ?? [])
    for (const f of listTestFiles(root, d)) need[f] ??= { min: 1, controls: 0 };
  for (const t of spec.titles ?? []) {
    const ts = (byFile.get(t.file) ?? []).filter(
      (x) => x.status === 'passed' && x.fullName.includes(t.includes),
    );
    if (ts.length < 1) problems.push(`${t.file}: 缺通过的关键用例(标题含 "${t.includes}")`);
  }
  for (const [f, req] of Object.entries(need)) {
    const ts = byFile.get(f) ?? [];
    const passed = ts.filter((t) => t.status === 'passed');
    if (passed.length < (req.min ?? 1))
      problems.push(`${f}: 通过用例 ${passed.length} < ${req.min ?? 1}(文件没跑或被删)`);
    const controls = passed.filter((t) => CONTROL_RE.test(t.fullName)).length;
    if (controls < (req.controls ?? 0))
      problems.push(`${f}: "正向控制"用例 ${controls} < ${req.controls}(负向断言可能静默变空)`);
  }
  return problems;
}

/** 通用:跑 vitest 文件集并核对 spec;并入 Reporter。 */
export function vitestStep(R, ctx, tmp, label, files, spec) {
  const v = runVitest(ctx, tmp, files);
  if (v.code === EXIT.NOT_RUN) {
    R.notRun(`${label}: ${v.why}`);
    return v;
  }
  const problems = v.evaluation ? [...v.evaluation.problems] : [];
  if (v.evaluation && spec) problems.push(...checkRequiredTests(v.evaluation, ctx.root, spec));
  if (problems.length) R.fail(`${label}: ${problems.join('; ')}`);
  else
    R.pass(
      `${label}: ${v.evaluation.passed}/${v.evaluation.total} 通过,skipped/todo=0,关键文件与正向控制齐全`,
    );
  return v;
}

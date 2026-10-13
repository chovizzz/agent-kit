// A22 attest / promote / retire 三条命令:零网络 + 零写入(干跑)。
//  ① 静态:三条命令源码的 import 传递闭包(src/**/*.ts)不得含 src/io/llm-exec.ts 或 src/reflect/backends/**;
//     闭包里 import node:child_process 的文件必须恰好是 src/io/exec.ts(attest 不用 git,必须为空),
//     且 exec.ts 的二进制白名单恰为 ['git'](源码正则 + dist 运行时各查一次);不得 import 网络模块、不得使用全局 fetch 等。
//     防假绿:对照 a)同一分析器对 reflect 命令必须报出 llm-exec/backends(探测有效);b)合成目录里的动态 import / export * from /
//     注释里的 import 各自按预期被识别或忽略;c)闭包文件数下限(图不是空的)。
//  ② 动态:合成仓库(git)+ 合成会话/信号 + 临时假 HOME + 独立 KIT_TMP/state,用 dist/cli.js 实跑三条命令干跑:
//     先断言(前置):子进程的 HOME 是假 HOME 且不等于真 HOME;快照比对函数对一次真实写入报差异;`--permission` 确实拒绝写入;
//     金丝雀二进制(codex/claude/pi/kimi/curl)被直接执行时确实留下文件。
//     然后:`node --permission`(只读 + 允许起子进程以便跑 git)下三条干跑必须退出 0、stdout 有内容;不带 permission 再跑一遍;
//     前后树哈希(仓库含 .git、state、假 HOME、git HOME、会话目录、KIT_TMP、金丝雀目录)必须逐字节相同,金丝雀文件不得出现;
//     真实 HOME 的受管路径快照前后无差异。`--write` 另跑:仓库树字节不变,state 里新增的路径全部落在 <命令名>/ 之下。
//     `--run-llm` / `--allow-egress` 出现即退出 2 且不写。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT,
  Reporter,
  cleanEnv,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
  sha256,
} from './common.mjs';
import { freshDist, importDist } from './accept-p1.mjs';
import { checkClosure, closure, specifiersOf } from './import-graph.mjs';
import { compareSnapshots, snapshotTargets } from './a19.mjs';
import { LESSON, buildDryWorld, loadWorldMods, writeSessions } from './lc-world.mjs';

export const COMMANDS = [
  // childExact:该命令的闭包里 import child_process 的文件集合必须恰好等于它(attest 不起任何子进程)
  { name: 'attest', entry: 'src/commands/attest.ts', child: [] },
  { name: 'promote', entry: 'src/commands/promote.ts', child: ['src/io/exec.ts'] },
  { name: 'retire', entry: 'src/commands/retire.ts', child: ['src/io/exec.ts'] },
];
export const FORBIDDEN = {
  forbiddenFiles: ['src/io/llm-exec.ts'],
  forbiddenPrefixes: ['src/reflect/backends/'],
};
export const EXEC_ALLOWLIST_WANT = ['git'];

/** 从 exec.ts 源码里抽取 EXEC_ALLOWLIST 的字面量数组;抽不到返回 undefined */
export function execAllowlistFromSource(text) {
  const m = /EXEC_ALLOWLIST\s*:\s*readonly\s+string\[\]\s*=\s*\[([^\]]*)\]/.exec(text);
  if (m === null) return undefined;
  return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
}

const sameArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 静态部分。返回问题数组。 */
export function staticChecks(root, execModule) {
  const problems = [];
  const notes = [];
  for (const c of COMMANDS) {
    const r = checkClosure(root, [c.entry], { ...FORBIDDEN, childAllow: c.child });
    for (const p of r.problems) problems.push(`${c.name}:${p}`);
    if (r.files.size < 20) problems.push(`${c.name}:闭包只有 ${r.files.size} 个文件(图不完整?)`);
    for (const must of [c.entry, 'src/io/safe-fs.ts'])
      if (!r.files.has(must)) problems.push(`${c.name}:闭包里没有 ${must}(分析器没走到)`);
    notes.push(`${c.name}=${r.files.size}`);
  }
  // 白名单:源码 + 运行时
  const src = fs.readFileSync(path.join(root, 'src/io/exec.ts'), 'utf8');
  const fromSrc = execAllowlistFromSource(src);
  if (fromSrc === undefined) problems.push('exec.ts 里抽不到 EXEC_ALLOWLIST 字面量');
  else if (!sameArr(fromSrc, EXEC_ALLOWLIST_WANT))
    problems.push(
      `exec.ts 的 EXEC_ALLOWLIST 应恰为 [${EXEC_ALLOWLIST_WANT}],源码里是 [${fromSrc}]`,
    );
  if (execModule !== undefined && !sameArr([...execModule.EXEC_ALLOWLIST], EXEC_ALLOWLIST_WANT))
    problems.push(
      `dist 运行时 EXEC_ALLOWLIST 应恰为 [${EXEC_ALLOWLIST_WANT}],实际 [${[...execModule.EXEC_ALLOWLIST]}]`,
    );
  return { problems, notes };
}

/** 分析器自身的对照(防探测失效)。返回问题数组。 */
export function analyzerControls(root, tmp) {
  const problems = [];
  // a) reflect 命令真的会 import llm-exec / backends:分析器必须报出
  const rf = checkClosure(root, ['src/commands/reflect.ts'], { ...FORBIDDEN, childAllow: [] });
  if (!rf.problems.some((p) => p.includes('src/io/llm-exec.ts')))
    problems.push('对照 a:reflect 命令的闭包里应能发现 src/io/llm-exec.ts,分析器没报出(探测失效)');
  if (!rf.problems.some((p) => p.includes('src/reflect/backends/')))
    problems.push(
      '对照 a:reflect 命令的闭包里应能发现 src/reflect/backends/**,分析器没报出(探测失效)',
    );
  // b) 合成目录:各种 import 写法
  const d = path.join(tmp, 'graph-control');
  fs.mkdirSync(path.join(d, 'src', 'io'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src', 'reflect', 'backends'), { recursive: true });
  const w = (rel, text) => fs.writeFileSync(path.join(d, rel), text);
  w('src/io/llm-exec.ts', 'export const x = 1;\n');
  w(
    'src/reflect/backends/b.ts',
    "import { spawn } from 'node:child_process';\nexport const b = spawn;\n",
  );
  const cases = [
    ['动态 import', "export const f = () => import('./io/llm-exec.js');\n", true],
    ['export * from', "export * from './io/llm-exec.js';\n", true],
    ['export { x } from', "export { x } from './io/llm-exec.js';\n", true],
    [
      'import type',
      "import type { x } from './io/llm-exec.js';\nexport type T = typeof x;\n",
      true,
    ],
    ['副作用 import', "import './io/llm-exec.js';\n", true],
    ['经 backends 目录', "import { b } from './reflect/backends/b.js';\nexport { b };\n", true],
    ['直接网络模块', "import * as h from 'node:https';\nexport { h };\n", true],
    ['全局 fetch', "export const g = () => fetch('http' + '://x');\n", true],
    [
      '注释里的 import 不算',
      "// import './io/llm-exec.js'\n/* import './io/llm-exec.js' */\nexport const ok = 1;\n",
      false,
    ],
  ];
  cases.forEach(([name, text, bad], i) => {
    w(`src/e${i}.ts`, text);
    const r = checkClosure(d, [`src/e${i}.ts`], { ...FORBIDDEN, childAllow: [] });
    // 经 backends 的用例同时会因 child_process 报错,也算命中;只关心"有无问题"
    if (bad && r.problems.length === 0) problems.push(`对照 b:「${name}」应被发现,分析器没报出`);
    if (!bad && r.problems.length > 0)
      problems.push(`对照 b:「${name}」不应报问题,却报了 ${r.problems[0]}`);
  });
  if (
    !specifiersOf("import a from './a.js';\nexport * from './b.js';\nimport('./c.js');").every(
      (s, i) => s === ['./a.js', './b.js', './c.js'][i],
    )
  )
    problems.push('对照 b2:specifiersOf 没抽全三种写法');
  void closure;
  return problems;
}

const CANARY_BINS = ['codex', 'claude', 'pi', 'kimi', 'curl'];
const canaryScript = (canary) => `#!/bin/sh\necho invoked > '${canary}'\ncat > /dev/null\nexit 0\n`;

async function a22(argv) {
  const R = new Reporter('A22');
  const { flags } = parseCommon(argv, { value: ['home'] });
  const ctx = makeCtx(flags);
  const fresh = freshDist(ctx);
  if (!fresh.ok) {
    R.notRun(fresh.why);
    return R.exit();
  }
  const snapLib = await import(
    pathToFileURL(path.join(ctx.root, 'ops', 'lib', 'snapshot.mjs')).href
  ).catch(() => null);
  if (!snapLib) {
    R.notRun('找不到 ops/lib/snapshot.mjs');
    return R.exit();
  }
  const permProbe = run(ctx.node, ['--permission', '-e', '0'], { env: cleanEnv() });
  if (permProbe.status !== 0) {
    R.notRun(`当前 node 不支持 --permission(退出 ${permProbe.status})`);
    return R.exit();
  }
  const mods = await loadWorldMods(ctx);
  const execMod = await importDist(ctx, 'io/exec.js');

  // ---------- ① 静态 ----------
  const st = staticChecks(ctx.root, execMod);
  for (const p of st.problems) R.fail(p);
  if (st.problems.length === 0)
    R.pass(
      `静态:三条命令的 import 闭包不含 llm-exec / reflect/backends,child_process 只在 exec.ts,白名单恰为 [git](闭包文件数 ${st.notes.join(' ')})`,
    );

  const tmp = mkTmp(ctx, 'a22');
  try {
    const ctl = analyzerControls(ctx.root, tmp);
    for (const p of ctl) R.fail(p);
    if (ctl.length === 0)
      R.pass('对照:分析器对 reflect / 合成坏例都能报出,对注释里的 import 不误报');

    // ---------- ② 动态 ----------
    const sb = sandbox(tmp);
    const state = path.join(sb.kit, 'state');
    const repo = path.join(tmp, 'repo');
    const gitHome = path.join(sb.kit, 'githome'); // git 的 HOME 也放进 KIT_TMP
    const sessions = path.join(tmp, 'sessions');
    const binDir = path.join(tmp, 'bin');
    const canaryDir = path.join(tmp, 'canary');
    for (const d of [binDir, canaryDir]) fs.mkdirSync(d, { recursive: true });
    const canaries = CANARY_BINS.map((n) => path.join(canaryDir, n));
    CANARY_BINS.forEach((n, i) =>
      fs.writeFileSync(path.join(binDir, n), canaryScript(canaries[i]), { mode: 0o755 }),
    );
    const ids = buildDryWorld(mods, repo, gitHome);
    writeSessions(sessions);
    const env = cleanEnv({
      HOME: sb.home,
      KIT_TMP: sb.kit,
      KIT_STATE_DIR: state,
      PATH: `${binDir}:${path.dirname(ctx.node)}:/usr/bin:/bin`,
    });
    const home = path.resolve(flags.home ?? snapLib.resolveHome());
    // 前置断言:子进程的 HOME 是假 HOME,且不是真 HOME 或其内部
    if (env.HOME === home || env.HOME.startsWith(`${home}${path.sep}`)) {
      R.fail('前置:子进程的 HOME 指向了真实 HOME(沙箱失效),不继续');
      return R.exit();
    }
    R.pass('前置:子进程 HOME 是临时假 HOME,不在真实 HOME 之内');

    const kit = (args, { perm, extraEnv } = {}) => {
      const nodeArgs = perm
        ? [
            '--permission',
            `--allow-fs-read=${ctx.root}`,
            `--allow-fs-read=${tmp}`,
            '--allow-child-process',
          ]
        : [];
      return run(ctx.node, [...nodeArgs, ctx.cli, '--root', repo, ...args], {
        cwd: tmp,
        env: { ...env, ...(extraEnv ?? {}) },
      });
    };

    // 准备:signals collect 产出带结构字段的信号(准备动作,不在测量窗口内)
    const prep = kit([
      'signals',
      'collect',
      '--source',
      sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--allow-project',
      'proj-b',
    ]);
    if (prep.status !== 0) {
      R.notRun(`准备阶段 signals collect 退出 ${prep.status}:${prep.stderr.slice(0, 160)}`);
      return R.exit();
    }

    // 正向对照
    const cdir = path.join(tmp, 'control');
    fs.mkdirSync(path.join(cdir, 'd'), { recursive: true });
    fs.writeFileSync(path.join(cdir, 'd', 'f'), 'x');
    const c0 = snapshotTargets({ cdir });
    fs.writeFileSync(path.join(cdir, 'd', 'g'), 'y');
    const cmp = compareSnapshots(c0, snapshotTargets({ cdir }));
    if (cmp.names.length === 1 && cmp.entries > 0)
      R.pass(`对照 a:快照比对能报出一次真实写入(差异条目 ${cmp.entries})`);
    else R.fail('对照 a:快照比对没有报出已发生的写入(探测本身失效)');

    const probeFile = path.join(cdir, 'perm-probe');
    const probeCode = `require('node:fs').writeFileSync(${JSON.stringify(probeFile)}, 'x')`;
    const denied = run(ctx.node, ['--permission', `--allow-fs-read=${cdir}`, '-e', probeCode], {
      env: cleanEnv(),
    });
    const deniedOk =
      denied.status !== 0 && /ERR_ACCESS_DENIED/.test(denied.stderr) && !fs.existsSync(probeFile);
    const allowed = run(ctx.node, ['-e', probeCode], { env: cleanEnv() });
    if (deniedOk && allowed.status === 0 && fs.existsSync(probeFile))
      R.pass('对照 b:--permission 确实拒绝写入(不带该选项则写入成功)');
    else R.fail('对照 b:--permission 对写入不生效');

    let canaryOk = true;
    for (const [i, n] of CANARY_BINS.entries()) {
      const r = run(path.join(binDir, n), [], { input: '', env: cleanEnv() });
      if (r.status !== 0 || !fs.existsSync(canaries[i])) canaryOk = false;
      fs.rmSync(canaries[i], { force: true });
    }
    if (canaryOk) R.pass(`对照 c:${CANARY_BINS.length} 个金丝雀二进制被直接执行时都会留下文件`);
    else R.fail('对照 c:金丝雀二进制直接执行没有留下文件(金丝雀机制失效)');

    // 测量窗口
    const managedText = fs.readFileSync(path.join(ctx.root, 'ops', 'managed-paths.txt'), 'utf8');
    const volatileText = fs.readFileSync(path.join(ctx.root, 'ops', 'volatile-paths.txt'), 'utf8');
    const adapterTargets = snapLib.readAdapterTargets(ctx.root).targets;
    const takeHome = () =>
      snapLib.takeSnapshot({ home, managedText, volatileText, adapterTargets, homeWatch: true });
    const targets = { tmp: tmp };
    const homeBefore = takeHome();
    const before = snapshotTargets({ ...targets });

    const DRY = [
      { name: 'promote', args: ['promote', '--rule', ids.promote, '--to', 'advisory', '--json'] },
      {
        name: 'retire',
        args: [
          'retire',
          '--rule',
          ids.retire,
          '--to',
          'deprecated',
          '--reason',
          'manual',
          '--json',
        ],
      },
      {
        name: 'attest',
        args: [
          'attest',
          '--rule',
          ids.attest,
          '--member',
          '@alice',
          '--window-start',
          '2026-10-01',
          '--window-end',
          '2026-10-14',
          '--json',
        ],
      },
    ];
    let ok = 0;
    for (const perm of [true, false]) {
      const tag = perm ? '--permission' : '无 permission+金丝雀';
      for (const d of DRY) {
        const r = kit(d.args, { perm });
        let j;
        try {
          j = JSON.parse(r.stdout);
        } catch {
          j = undefined;
        }
        if (r.status !== 0)
          R.fail(`${d.name} 干跑(${tag}):退出 ${r.status}(应为 0):${r.stderr.slice(0, 160)}`);
        else if (/ERR_ACCESS_DENIED/.test(r.stderr))
          R.fail(
            `${d.name} 干跑(${tag}):stderr 出现 ERR_ACCESS_DENIED(干跑路径试图写入/起不被允许的子进程)`,
          );
        else if (j === undefined) R.fail(`${d.name} 干跑(${tag}):stdout 不是 JSON`);
        else if (j.dry !== true || j.wrote !== false)
          R.fail(`${d.name} 干跑(${tag}):不是干跑(dry=${j.dry} wrote=${j.wrote})`);
        else if (d.name === 'attest' && !(j.exposure_sessions > 0))
          R.fail(`attest 干跑(${tag}):窗口内计数为 0,测不到东西`);
        else if (d.name === 'promote' && j.rule_id !== ids.promote)
          R.fail(`promote 干跑(${tag}):输出的规则不对`);
        else ok++;
      }
    }
    if (ok === 6)
      R.pass('干跑 6/6 次正常结束且有内容(promote / retire / attest × permission 与否)');

    // 用法错路径:egress 旗标 -> 退出 2,且不写
    let usageOk = 0;
    for (const d of DRY) {
      for (const flag of ['--run-llm', '--allow-egress']) {
        const r = kit([...d.args, flag], { perm: false });
        if (r.status === 2) usageOk++;
        else R.fail(`${d.name} ${flag}:应退出 2,实际 ${r.status}`);
      }
    }
    if (usageOk === 6) R.pass('三条命令遇到 --run-llm / --allow-egress 一律退出 2');

    if (canaries.some((c) => fs.existsSync(c)))
      R.fail('干跑后出现了金丝雀文件:有命令调用了外部二进制');
    else R.pass('干跑后金丝雀文件都不存在(codex/claude/pi/kimi/curl 均未被调用)');

    const after = snapshotTargets({ ...targets });
    const diff = compareSnapshots(before, after);
    if (diff.names.length === 0) {
      const total = Object.values(after).reduce((n, s) => n + s.count, 0);
      R.pass(`沙箱树哈希前后一致(仓库含 .git、state、假 HOME、会话、金丝雀目录;${total} 个条目)`);
    } else R.fail(`沙箱前后有差异:差异条目 ${diff.entries}`);
    const homeDiff = snapLib.diffSnapshots(homeBefore, takeHome());
    if (homeDiff.count === 0)
      R.pass(`真实 HOME 受管路径前后无差异(${homeBefore.stats.recorded_paths} 条记录)`);
    else
      R.attribute(
        `真实 HOME 受管路径出现 ${homeDiff.count} 处差异(摘要 ${sha256(JSON.stringify(homeDiff)).slice(0, 12)});多半是其它进程的写入,请归因`,
      );

    // --write:只写 state/<命令名>/,仓库字节不变
    const repoBefore = snapshotTargets({ repo });
    const stateBefore = snapshotTargets({ state }).state.entries;
    let wrote = 0;
    for (const d of DRY) {
      const r = kit([...d.args, '--write'], { perm: false });
      let j;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        j = undefined;
      }
      if (r.status === 0 && j?.wrote === true) wrote++;
      else R.fail(`${d.name} --write:退出 ${r.status} wrote=${j?.wrote}:${r.stderr.slice(0, 120)}`);
    }
    const repoDiff = compareSnapshots(repoBefore, snapshotTargets({ repo }));
    if (repoDiff.names.length === 0)
      R.pass('--write 之后仓库树(含 rules/ attest/ lifecycle/ 与 .git)字节不变');
    else R.fail(`--write 改了仓库树(${repoDiff.entries} 处)`);
    const stateAfter = snapshotTargets({ state }).state.entries;
    const added = stateAfter.filter((e) => !stateBefore.includes(e)).map((e) => e.split('\t')[0]);
    const stray = added.filter((p) => !DRY.some((d) => p.startsWith(`${d.name}/`)));
    const per = Object.fromEntries(
      DRY.map((d) => [d.name, added.filter((p) => p.startsWith(`${d.name}/`)).length]),
    );
    const wantPer = { promote: 3, retire: 3, attest: 2 }; // 补丁 + 报告 (+ PR 描述)
    const perOk = DRY.every((d) => per[d.name] === wantPer[d.name]);
    if (wrote === 3 && perOk && stray.length === 0)
      R.pass(
        `--write 只在 state/<命令名>/ 下新增文件(promote ${per.promote}、retire ${per.retire}、attest ${per.attest})`,
      );
    else
      R.fail(
        `--write 的落点不对:新增 ${JSON.stringify(per)},越界 [${stray.join(',')}],成功 ${wrote}/3`,
      );
    void LESSON;
  } finally {
    rmTmp(tmp);
  }
  void EXIT;
  return R.exit();
}

await runMain(import.meta.url, 'A22', () => a22(process.argv.slice(2)));

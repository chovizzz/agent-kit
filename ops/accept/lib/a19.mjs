// A19 reflect / judge 干跑零写入。在**临时假 HOME + 独立 KIT_TMP/state + 合成会话与提案**里,用 dist/cli.js 实跑:
//   ①`node --permission`(不授予任何写权限、不授予起子进程)下 reflect 与 judge 干跑必须退出 0(任何写入/起子进程都会被拒;
//     命令若吞掉错误,stderr 里也看不到 ERR_ACCESS_DENIED,所以真正起判据作用的是退出码与后面的快照对比);
//   ②不带 --permission 再跑一遍(覆盖层绑了一个会留下金丝雀文件的假 codex,并允许外发/放行未核实参数集):金丝雀不得出现;
//   ③前后对比:仓库、state、假 HOME、KIT_TMP、假二进制目录的树哈希必须逐字节相同;真实 HOME 的受管路径快照(ops/lib/snapshot.mjs)前后无差异。
// 防假绿(正向对照):a)同一套快照/比对函数对一次真实写入必须报出差异;b)`--permission` 对写入确实生效(带与不带各试一次);
//   c)假 codex 被直接执行时金丝雀确实出现,且经 kit 真跑(--run-llm --allow-egress)时也会被调用——证明干跑下的"没出现"有意义;
//   d)干跑输出必须有内容(聚类/证据数 > 0、judge 计划状态 planned),不是空转。
// 输出只含计数与哈希前缀。真跑不在零写入覆盖范围(contracts §12.4):c) 的真跑只用于证明可达性,发生在最终快照之后。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT,
  Reporter,
  cleanEnv,
  copyFiles,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
  sha256,
  treeHash,
} from './common.mjs';
import { freshDist } from './accept-p1.mjs';
import { OK_TEXT, RUN_ID as JUDGE_RUN, writeRunDir } from './a18.mjs';
import { commitStaged, initRepo } from './lc-world.mjs';

/** 目录/文件的快照:name → { hash, count }。不存在记 absent。 */
export function snapshotTargets(targets) {
  const out = {};
  for (const [name, p] of Object.entries(targets)) {
    if (!fs.existsSync(p)) out[name] = { hash: 'absent', count: 0, entries: [] };
    else if (fs.statSync(p).isDirectory()) out[name] = treeHash(p);
    else
      out[name] = {
        hash: sha256(fs.readFileSync(p)),
        count: 1,
        entries: [`${path.basename(p)}\t${sha256(fs.readFileSync(p))}`],
      };
  }
  return out;
}

/** 比对两份快照:返回 { names: 有差异的目标名, entries: 差异条目总数 }。 */
export function compareSnapshots(before, after) {
  const names = [];
  let entries = 0;
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[name];
    const a = after[name];
    if (b === undefined || a === undefined || b.hash !== a.hash) {
      names.push(name);
      const bs = new Set(b?.entries ?? []);
      const as = new Set(a?.entries ?? []);
      entries +=
        [...as].filter((e) => !bs.has(e)).length + [...bs].filter((e) => !as.has(e)).length;
    }
  }
  return { names: names.sort(), entries };
}

const KIT_TOML = `[kit]
name = "a19"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = 100000
limit_source = "documented"

[channels.canary.members]

[channels.stable.members]
`;

const claudeSession = (cwd, id, users) =>
  [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    ...users.map((text, i) =>
      JSON.stringify({
        type: 'user',
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        sessionId: id,
        cwd,
        version: '2.1.294',
        message: { role: 'user', content: text },
      }),
    ),
    '',
  ].join('\n');

// Claude reader 只认 <UUID>.jsonl 的文件名(口径 §2.1)
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';

const fakeCodex = (canary, out) =>
  `#!/bin/sh\necho invoked > '${canary}'\ncat > /dev/null\nprintf '%s' '${out}'\n`;

async function a19(argv) {
  const R = new Reporter('A19');
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
    R.notRun(
      `当前 node 不支持 --permission(退出 ${permProbe.status}):${permProbe.stderr.slice(0, 120)}`,
    );
    return R.exit();
  }

  const tmp = mkTmp(ctx, 'a19');
  try {
    // ---------- 沙箱 ----------
    const sb = sandbox(tmp); // { home, kit };KIT_TMP=kit,state 放在 kit 之内
    const state = path.join(sb.kit, 'state');
    const repoR = path.join(tmp, 'repo-reflect');
    const repoJ = path.join(tmp, 'repo-judge');
    const sessions = path.join(tmp, 'sessions');
    const binR = path.join(tmp, 'bin-reflect');
    const binJ = path.join(tmp, 'bin-judge');
    const canaryR = path.join(tmp, 'canary-reflect');
    const canaryJ = path.join(tmp, 'canary-judge');
    const overlay = path.join(tmp, 'overlay.toml');
    for (const d of [
      repoR,
      binR,
      binJ,
      path.join(sessions, 'proj-a'),
      path.join(sessions, 'proj-b'),
    ])
      fs.mkdirSync(d, { recursive: true });
    // 仓库:kit.toml + 一个真实规则文件副本(advisory + signature,进预算)+ CODEOWNERS + cases
    const real = fs
      .readFileSync(path.join(ctx.root, 'rules', 'org', 'keep-changes-minimal.md'), 'utf8')
      .replace('status: proposed', 'status: advisory')
      .replace(
        'verifier:\n',
        'signature:\n  type: phrase\n  pattern: zzz-unrelated-pattern\nverifier:\n',
      );
    fs.writeFileSync(path.join(repoR, 'kit.toml'), KIT_TOML);
    fs.writeFileSync(
      path.join(repoR, 'CODEOWNERS'),
      fs.readFileSync(path.join(ctx.root, 'CODEOWNERS')),
    );
    fs.mkdirSync(path.join(repoR, 'rules', 'org'), { recursive: true });
    fs.writeFileSync(path.join(repoR, 'rules', 'org', 'keep-changes-minimal.md'), real);
    copyFiles(
      ctx.root,
      ['cases/keep-changes-minimal/case.yaml', 'cases/keep-changes-minimal/check.sh'],
      repoR,
    );
    fs.writeFileSync(
      overlay,
      '[reflect]\negress = true\n\n[[reflect.backends]]\nslot = "codex"\ncli = "codex"\nmodel = "gpt-5.6-test"\nallow_unverified = true\n',
    );
    fs.writeFileSync(path.join(binR, 'codex'), fakeCodex(canaryR, '{"proposals":[]}'), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(binJ, 'codex'), fakeCodex(canaryJ, OK_TEXT.replace(/'/g, '')), {
      mode: 0o755,
    });
    // 合成会话(两个项目,各有一条"教训"):运行时写出,仓库里没有会话字面量
    const lesson = '以后提交代码前必须先运行 lint 检查并修复全部告警';
    fs.writeFileSync(
      path.join(sessions, 'proj-a', `${UUID_A}.jsonl`),
      claudeSession('/work/proj-a', UUID_A, [lesson, '你好']),
    );
    fs.writeFileSync(
      path.join(sessions, 'proj-b', `${UUID_B}.jsonl`),
      claudeSession('/work/proj-b', UUID_B, [lesson + '。']),
    );
    // judge 的合成 run:提案在 state 下;judge 的仓库只需放一个已知原子占位
    const yaml = await import('yaml');
    writeRunDir(yaml, repoJ, state, {
      vendor: 'anthropic',
      provider: 'anthropic',
      backend: 'claude',
    });
    // judge 真跑(对照 c3)要写冻结记录,需要仓库 HEAD 作外部锚点(缺 HEAD → JUDGE_STATE_INVALID,退 3)。
    // 在快照之前把 judge 仓库提交成真 git 仓库;git 的 HOME 是 tmp 内的空目录,不碰真实 HOME/全局配置
    const gitHomeJ = path.join(tmp, 'githome-judge');
    initRepo(repoJ, gitHomeJ);
    commitStaged(repoJ, gitHomeJ, 'a19 judge world');

    const envFor = (bin) =>
      cleanEnv({
        HOME: sb.home,
        KIT_TMP: sb.kit,
        KIT_STATE_DIR: state,
        PATH: `${bin}:${path.dirname(ctx.node)}:/usr/bin:/bin`,
      });
    const kit = (repo, args, { env, perm }) => {
      const nodeArgs = perm
        ? ['--permission', `--allow-fs-read=${ctx.root}`, `--allow-fs-read=${tmp}`]
        : [];
      return run(ctx.node, [...nodeArgs, ctx.cli, '--root', repo, '--overlay', overlay, ...args], {
        cwd: tmp,
        env,
      });
    };

    // ---------- 准备:signals collect 产出带结构字段的信号(准备动作,不在测量窗口内) ----------
    const prep = kit(
      repoR,
      [
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
      ],
      { env: envFor(binR), perm: false },
    );
    if (prep.status !== 0) {
      R.notRun(`准备阶段 signals collect 退出 ${prep.status}:${prep.stderr.slice(0, 160)}`);
      return R.exit();
    }

    // ---------- 正向对照(与被测目录无关) ----------
    const ctl = path.join(tmp, 'control');
    fs.mkdirSync(path.join(ctl, 'd'), { recursive: true });
    fs.writeFileSync(path.join(ctl, 'd', 'f'), 'x');
    const c0 = snapshotTargets({ ctl });
    fs.writeFileSync(path.join(ctl, 'd', 'g'), 'y');
    const c1 = snapshotTargets({ ctl });
    const cmp = compareSnapshots(c0, c1);
    if (cmp.names.length === 1 && cmp.entries > 0)
      R.pass(`对照 a:快照比对能报出一次真实写入(差异条目 ${cmp.entries})`);
    else R.fail('对照 a:快照比对没有报出已发生的写入(探测本身失效)');
    if (compareSnapshots(c1, snapshotTargets({ ctl })).names.length === 0)
      R.pass('对照 a2:无变化时比对为空');
    else R.fail('对照 a2:无变化却报告了差异');

    const probeFile = path.join(ctl, 'perm-probe');
    const probeCode = `require('node:fs').writeFileSync(${JSON.stringify(probeFile)}, 'x')`;
    const denied = run(ctx.node, ['--permission', `--allow-fs-read=${ctl}`, '-e', probeCode], {
      env: cleanEnv(),
    });
    const deniedOk =
      denied.status !== 0 && /ERR_ACCESS_DENIED/.test(denied.stderr) && !fs.existsSync(probeFile);
    const allowed = run(ctx.node, ['-e', probeCode], { env: cleanEnv() });
    const allowedOk = allowed.status === 0 && fs.existsSync(probeFile);
    if (deniedOk && allowedOk) R.pass('对照 b:--permission 确实拒绝写入(不带该选项则写入成功)');
    else R.fail(`对照 b:--permission 对写入不生效(denied=${deniedOk} allowed=${allowedOk})`);

    const direct = run(path.join(binR, 'codex'), [], { input: '', env: cleanEnv() });
    if (direct.status === 0 && fs.existsSync(canaryR)) {
      R.pass('对照 c:假 codex 被直接执行时金丝雀出现');
      fs.rmSync(canaryR);
    } else R.fail('对照 c:假 codex 直接执行没有留下金丝雀(金丝雀机制失效)');

    // ---------- 测量窗口 ----------
    const home = path.resolve(flags.home ?? snapLib.resolveHome());
    const managedText = fs.readFileSync(path.join(ctx.root, 'ops', 'managed-paths.txt'), 'utf8');
    const volatileText = fs.readFileSync(path.join(ctx.root, 'ops', 'volatile-paths.txt'), 'utf8');
    const adapterTargets = snapLib.readAdapterTargets(ctx.root).targets;
    const takeHome = () =>
      snapLib.takeSnapshot({ home, managedText, volatileText, adapterTargets, homeWatch: true });
    const targets = {
      tmp,
      repoR,
      repoJ,
      kit: sb.kit,
      home: sb.home,
      binR,
      binJ,
      overlay,
      sessions,
    };
    const before = snapshotTargets(targets);
    const homeBefore = takeHome();

    const checkDry = (label, r, expectJson) => {
      if (r.status !== 0) {
        R.fail(`${label}:退出 ${r.status}(应为 0)::${r.stderr.slice(0, 160)}`);
        return false;
      }
      if (/ERR_ACCESS_DENIED/.test(r.stderr)) {
        R.fail(`${label}:stderr 出现 ERR_ACCESS_DENIED(干跑路径试图写入/起子进程)`);
        return false;
      }
      let j;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        R.fail(`${label}:stdout 不是 JSON`);
        return false;
      }
      const msg = expectJson(j);
      if (msg) {
        R.fail(`${label}:${msg}`);
        return false;
      }
      return true;
    };
    const reflectOk = (j) =>
      j.mode !== 'dry'
        ? `mode=${j.mode}`
        : !(j.plan?.evidence > 0 && j.plan?.clusters > 0)
          ? `干跑计划是空的(clusters=${j.plan?.clusters} evidence=${j.plan?.evidence}):测不到东西`
          : j.calls?.made !== 0
            ? `干跑调用了后端 ${j.calls?.made} 次`
            : j.signals?.structure_unknown !== 0
              ? '信号缺结构字段'
              : '';
    const judgeOk = (j) =>
      j.dry !== true
        ? 'dry!==true'
        : !(
              j.proposals?.length === 1 &&
              j.proposals[0].status === 'planned' &&
              j.proposals[0].wrote === false
            )
          ? `judge 干跑计划不对:${JSON.stringify((j.proposals ?? []).map((p) => [p.status, p.wrote]))}`
          : j.calls_made !== 0
            ? `judge 干跑调用了后端 ${j.calls_made} 次`
            : '';

    let okRuns = 0;
    for (const perm of [true, false]) {
      const tag = perm ? '--permission' : '无 permission+金丝雀';
      const r1 = kit(repoR, ['reflect', '--json'], { env: envFor(binR), perm });
      if (checkDry(`reflect 干跑(${tag})`, r1, reflectOk)) okRuns++;
      const r2 = kit(repoJ, ['judge', '--run', JUDGE_RUN], { env: envFor(binJ), perm });
      if (checkDry(`judge 干跑(${tag})`, r2, judgeOk)) okRuns++;
      const r3 = kit(repoR, ['reflect', '--show-prompt'], { env: envFor(binR), perm });
      if (r3.status === 0 && !/ERR_ACCESS_DENIED/.test(r3.stderr) && r3.stdout.length > 0) okRuns++;
      else R.fail(`reflect --show-prompt 干跑(${tag}):退出 ${r3.status}`);
    }
    if (okRuns === 6)
      R.pass('干跑 6/6 次正常结束且有内容(reflect 计划、judge 计划、--show-prompt)');

    const canaryAfter = fs.existsSync(canaryR) || fs.existsSync(canaryJ);
    if (canaryAfter) R.fail('干跑后出现了假 codex 的金丝雀:后端被构造并调用了');
    else R.pass('干跑后两个金丝雀都不存在(覆盖层已允许外发、已绑定后端、已放行未核实参数集)');

    const after = snapshotTargets(targets);
    const diff = compareSnapshots(before, after);
    if (diff.names.length === 0) {
      const totalEntries = Object.values(after).reduce((n, s) => n + s.count, 0);
      R.pass(
        `沙箱树哈希前后一致(${Object.keys(after).length} 个目标、${totalEntries} 个条目;组合哈希 ${sha256(JSON.stringify(Object.values(after).map((s) => s.hash))).slice(0, 12)})`,
      );
    } else R.fail(`沙箱前后有差异:目标 ${diff.names.join(',')},差异条目 ${diff.entries}`);

    const homeDiff = snapLib.diffSnapshots(homeBefore, takeHome());
    if (homeDiff.count === 0)
      R.pass(`真实 HOME 受管路径前后无差异(${homeBefore.stats.recorded_paths} 条记录)`);
    else
      R.attribute(
        `真实 HOME 受管路径出现 ${homeDiff.count} 处差异(差异摘要 ${sha256(JSON.stringify(homeDiff)).slice(0, 12)});请用 ops/zero-write-check.sh 归因,多半是其它进程的写入`,
      );

    // ---------- 真跑可达性对照(在最终快照之后;真跑不在零写入范围内,contracts §12.4) ----------
    const live = kit(
      repoR,
      ['reflect', '--run-llm', '--allow-egress', '--owner', '@chovizzz', '--json'],
      {
        env: envFor(binR),
        perm: false,
      },
    );
    let liveCalls = -1;
    try {
      liveCalls = JSON.parse(live.stdout).calls.made;
    } catch {
      /* 保持 -1 */
    }
    if (live.status === 0 && fs.existsSync(canaryR) && liveCalls === 1)
      R.pass('对照 c2:同一覆盖层下经 kit 真跑会调用假 codex(干跑下的"金丝雀不存在"有意义)');
    else
      R.fail(
        `对照 c2:kit 真跑没有调用假 codex(退出 ${live.status},calls=${liveCalls},金丝雀=${fs.existsSync(canaryR)})`,
      );
    const liveJ = kit(repoJ, ['judge', '--run', JUDGE_RUN, '--run-llm', '--allow-egress'], {
      env: envFor(binJ),
      perm: false,
    });
    if (liveJ.status === 0 && fs.existsSync(canaryJ)) R.pass('对照 c3:judge 真跑会调用假 codex');
    else
      R.fail(
        `对照 c3:judge 真跑没有调用假 codex(退出 ${liveJ.status},金丝雀=${fs.existsSync(canaryJ)})`,
      );
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A19', () => a19(process.argv.slice(2)));
void EXIT;

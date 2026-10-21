// A25 sync 往返。在**仓库外**的临时假 HOME(KIT_TMP 之内;真实路径与符号链接形式各跑一遍)里,用 dist 里的真 sync 命令层实跑:
//   ①干跑:零写入(树含 mtime 不变、不建状态目录);
//   ②安装(--write)后再装一次:幂等,零操作、零 mtime 变化(含目录项与状态目录);
//   ③往返:安装→卸载(--uninstall)、安装→回滚(--rollback <txn>),受管路径树的「文件集合(相对路径 + 权限位 + 内容 sha256)」
//     与安装前逐字节一致(契约 §19.2:忽略 .local/state/agent-kit/**;新增的目录子树里不得有文件);
//   ④每种场景分「空 HOME」与「已有用户文件(含两份会被追加托管块的 AGENTS.md)」两种起点;
//   ⑤真实 HOME 的受管路径与套件自己的 share/state/config 目录前后无差异。
// 防假绿(正向控制):a)比较函数对一次真实改动、一个非空新增目录都必须报出;b)安装后树必须确实变了、关键文件存在(不是空转);
//   c)no-net 垫片装好后一次必被拦的 fetch 要留痕;d)往返用的 txn id 必须来自安装输出。
// 输出只含计数与受管相对路径。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Reporter,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  runMain,
} from './common.mjs';
import { freshDist } from './accept-p1.mjs';
import {
  CODEX_MD,
  PI_MD,
  RULES,
  SHARED,
  SKILL,
  STATE_REL,
  compareExact,
  compareRoundtrip,
  installNoNet,
  jsonOf,
  loadMods,
  makeWorldDirs,
  realHomeGuard,
  runSync,
  seedHome,
  snapTree,
  syncFixture,
  writePayloadFixture,
} from './sk-world.mjs';

const INSTALLED = [SKILL, SHARED, RULES];

async function scenario(R, ctx, mods, form, seeded) {
  const tag = `${form === 'link' ? '符号链接' : '真实路径'}/${seeded ? '已有用户文件' : '空HOME'}`;
  const dirs = makeWorldDirs(ctx, 'a25', form);
  try {
    writePayloadFixture(mods, dirs.pkg, syncFixture());
    if (seeded) seedHome(dirs.home);
    const before = snapTree(dirs.home, { skipState: true });
    const beforeFull = snapTree(dirs.home);
    const sync = (args) => runSync(mods, ctx, dirs, args);

    // ① 干跑零写入
    const dry = await sync([]);
    const dryDiff = compareExact(beforeFull, snapTree(dirs.home));
    if (dry.code !== 0 || !/^would create /m.test(dry.out) || /^did /m.test(dry.out))
      R.fail(`${tag}: 干跑应退出 0 且只有 would 行(退出 ${dry.code})::${dry.err.slice(0, 120)}`);
    else if (dryDiff.length > 0 || fs.existsSync(path.join(dirs.home, STATE_REL)))
      R.fail(`${tag}: 干跑有写入:${dryDiff.slice(0, 3).join('; ') || '建了状态目录'}`);
    else R.pass(`${tag}: 干跑退出 0、零写入(树含 mtime 不变、无状态目录)`);

    // ② 安装;③ 幂等
    const inst = await sync(['--write', '--json']);
    const ij = jsonOf(inst.out);
    if (inst.code !== 0 || ij === null || typeof ij.txn !== 'string' || !/^txn-/.test(ij.txn)) {
      R.fail(`${tag}: --write 安装失败(退出 ${inst.code}, txn=${ij?.txn}):${inst.err.slice(0, 160)}`);
      return;
    }
    const installed = snapTree(dirs.home, { skipState: true });
    const changed = compareRoundtrip(before, installed);
    const missing = INSTALLED.filter((f) => !installed.files.has(f));
    const blocksOk = [CODEX_MD, PI_MD].every((f) => installed.files.has(f));
    if (changed.length === 0 || missing.length > 0 || !blocksOk || !fs.existsSync(path.join(dirs.home, STATE_REL)))
      R.fail(`${tag}: 安装后树没有按预期变化(改动 ${changed.length};缺 ${missing.join(',') || '无'})——往返比较会是空转`);
    else R.pass(`${tag}: 安装落盘(${ij.ops.length} 个操作,${changed.length} 处树差异),txn=${ij.txn.slice(0, 12)}…`);

    const mid = snapTree(dirs.home);
    const again = await sync(['--write', '--json']);
    const aj = jsonOf(again.out);
    const idemDiff = compareExact(mid, snapTree(dirs.home));
    if (
      again.code !== 0 ||
      aj === null ||
      (aj.txn !== null && aj.txn !== undefined) ||
      /^did /m.test(again.out)
    )
      R.fail(`${tag}: 第二次 --write 应零操作(退出 ${again.code}, txn=${aj?.txn})`);
    else if (idemDiff.length > 0)
      R.fail(`${tag}: 幂等运行改变了树/mtime:${idemDiff.slice(0, 3).join('; ')}`);
    else R.pass(`${tag}: 幂等(第二次 --write 零操作、零 mtime 变化)`);

    // ③a 卸载往返
    const un = await sync(['--write', '--uninstall', '--json']);
    const afterUn = snapTree(dirs.home, { skipState: true });
    const unProblems = compareRoundtrip(before, afterUn);
    if (un.code !== 0) R.fail(`${tag}: --uninstall 退出 ${un.code}:${un.err.slice(0, 160)}`);
    else if (unProblems.length > 0)
      R.fail(`${tag}: 装→卸后受管路径树与安装前不一致(${unProblems.length} 处):${unProblems.slice(0, 4).join('; ')}`);
    else
      R.pass(
        `${tag}: 装→卸往返逐字节一致(${before.files.size} 个文件;新增目录 ${[...afterUn.dirs].filter((d) => !before.dirs.has(d)).length} 个且均无文件)`,
      );
  } finally {
    dirs.cleanup();
  }
}

/** 回滚往返用全新的世界:安装 → 取安装输出里的 txn → --rollback。 */
async function rollbackScenario(R, ctx, mods, form, seeded) {
  const tag = `${form === 'link' ? '符号链接' : '真实路径'}/${seeded ? '已有用户文件' : '空HOME'}`;
  const dirs = makeWorldDirs(ctx, 'a25r', form);
  try {
    writePayloadFixture(mods, dirs.pkg, syncFixture());
    if (seeded) seedHome(dirs.home);
    const before = snapTree(dirs.home, { skipState: true });
    const inst = await runSync(mods, ctx, dirs, ['--write', '--json']);
    const txn = jsonOf(inst.out)?.txn;
    if (inst.code !== 0 || typeof txn !== 'string') {
      R.fail(`${tag}: 回滚用例的安装失败(退出 ${inst.code})::${inst.err.slice(0, 160)}`);
      return;
    }
    const rb = await runSync(mods, ctx, dirs, ['--write', '--rollback', txn, '--json']);
    const after = snapTree(dirs.home, { skipState: true });
    const problems = compareRoundtrip(before, after);
    if (rb.code !== 0) R.fail(`${tag}: --rollback ${txn.slice(0, 12)}… 退出 ${rb.code}:${rb.err.slice(0, 160)}`);
    else if (problems.length > 0)
      R.fail(`${tag}: 装→回滚后树与安装前不一致(${problems.length} 处):${problems.slice(0, 4).join('; ')}`);
    else R.pass(`${tag}: 装→回滚往返逐字节一致(${before.files.size} 个文件)`);
  } finally {
    dirs.cleanup();
  }
}

/** 比较函数自身的正向控制:一次真实改动、一个非空新增目录、一次 mtime 变化都必须被报出。 */
function selfCheck(R, ctx) {
  const tmp = mkTmp(ctx, 'a25c');
  try {
    const h = path.join(tmp, 'h');
    fs.mkdirSync(path.join(h, 'd'), { recursive: true });
    fs.writeFileSync(path.join(h, 'd', 'f.txt'), 'x\n');
    const base = snapTree(h, { skipState: true });
    const baseFull = snapTree(h);
    const ok0 = compareRoundtrip(base, snapTree(h, { skipState: true })).length === 0;
    fs.writeFileSync(path.join(h, 'd', 'f.txt'), 'y\n');
    const c1 = compareRoundtrip(base, snapTree(h, { skipState: true })).length > 0;
    fs.writeFileSync(path.join(h, 'd', 'f.txt'), 'x\n');
    fs.mkdirSync(path.join(h, 'new'));
    fs.writeFileSync(path.join(h, 'new', 'left.txt'), 'z\n');
    const c2 = compareRoundtrip(base, snapTree(h, { skipState: true })).some((p) => p.includes('不为空'));
    fs.rmSync(path.join(h, 'new'), { recursive: true });
    fs.mkdirSync(path.join(h, '.local/state/agent-kit'), { recursive: true });
    fs.writeFileSync(path.join(h, '.local/state/agent-kit/x'), 'x');
    const c3 = compareRoundtrip(base, snapTree(h, { skipState: true })).length === 0; // 状态目录被忽略
    const c4 = compareExact(baseFull, snapTree(h)).length > 0; // 完整快照看得到状态目录
    const s1 = snapTree(h);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(h, 'd', 'f.txt'), t, t);
    const c5 = compareExact(s1, snapTree(h)).some((p) => p.startsWith('mtime 变化'));
    if (ok0 && c1 && c2 && c3 && c4 && c5) R.pass('正向控制:比较函数对改动/非空新增目录/mtime 变化报出,对状态目录豁免');
    else R.fail(`正向控制失败(同一 ${[ok0, c1, c2, c3, c4, c5].join('/')}):比较函数可能静默变空`);
  } finally {
    rmTmp(tmp);
  }
}

async function a25(argv) {
  const R = new Reporter('A25');
  const { flags } = parseCommon(argv, { value: ['home'] });
  const ctx = makeCtx(flags);
  const fresh = freshDist(ctx);
  if (!fresh.ok) {
    R.notRun(fresh.why);
    return R.exit();
  }
  const mods = await loadMods(ctx).catch((e) => {
    R.notRun(`加载 dist 模块失败:${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  });
  if (!mods) return R.exit();
  const guard = await realHomeGuard(ctx, flags.home);
  const homeBefore = guard.take();
  const tmp = mkTmp(ctx, 'a25n');
  try {
    const net = await installNoNet(ctx, tmp);
    if (!net.controlOk) {
      R.notRun('no-net 垫片没有拦住对照 fetch(无法证明零网络)');
      return R.exit();
    }
    selfCheck(R, ctx);
    for (const form of ['real', 'link'])
      for (const seeded of [false, true]) {
        await scenario(R, ctx, mods, form, seeded);
        await rollbackScenario(R, ctx, mods, form, seeded);
      }
    const hits = net.blocked();
    if (hits.length === 0) R.pass('运行期零网络(no-net 垫片未被触发)');
    else R.fail(`运行期触碰了网络 API:${hits.slice(0, 2).join(' | ')}`);
  } finally {
    rmTmp(tmp);
  }
  const homeAfter = guard.take();
  const n = guard.diff(homeBefore, homeAfter);
  if (n === 0) R.pass('真实 HOME 的受管路径与套件 share/state/config 目录前后无差异');
  else
    R.attribute(
      `真实 HOME 出现 ${n} 处差异;请用 ops/zero-write-check.sh 归因(多半是其它进程的写入,sync 全程只用 --home 假 HOME)`,
    );
  return R.exit();
}

await runMain(import.meta.url, 'A25', () => a25(process.argv.slice(2)));

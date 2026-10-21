// A27 更新(假 registry)。在仓库外的临时假 HOME 里,用 dist 里的真 update 命令层 + `KIT_UPDATE_REGISTRY=file://<KIT_TMP 内目录>`
// 夹具(真实路径与符号链接形式的 KIT_TMP 各跑一遍),零真实网络(进程内加载 no-net 垫片,并有一次必被拦的 fetch 作正向对照):
//   ①检查(干跑):打印 would install / decision ok,假 HOME 零写入、不建状态目录;
//   ②安装:--write 装到 versions/<v>,current 指过去,状态记锚点,验签恰好一次;再跑一次 up_to_date、不再验签;
//   ③回滚:切回上一版并记入 bad_versions,之后不会自动装回;没有上一版 => 退出 4 no_previous;回滚不碰网络(registry 目录不存在也能回滚);
//   ④registry 夹具在 KIT_TMP 之外(含经符号链接指出去)=> 退出 2 registry_fixture_outside_tmp,零写入;
//   ⑤完整性不符(dist.integrity 与 tarball 不符 / 包内 integrity.json 与文件不符)=> 退出 1 UPDATE_VERIFY_FAILED,current 不变、新版本目录不落盘。
// 验签用注入的假验证器(真验签由 provenance 自己的测试覆盖);其余路径(registry 读取、sha512、完整性、tar、冒烟、current 切换、状态)都是真代码。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Reporter, makeCtx, mkTmp, parseCommon, rmTmp, runMain } from './common.mjs';
import { freshDist } from './accept-p1.mjs';
import {
  buildPkg,
  compareExact,
  currentVersion,
  installNoNet,
  loadMods,
  makeWorldDirs,
  realHomeGuard,
  runUpdate,
  share,
  snapTree,
  updateState,
  writeRegistry,
} from './sk-world.mjs';

const versionsOf = (dirs) => {
  const d = path.join(share(dirs), 'versions');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const stagingResidue = (dirs) => {
  const d = path.join(share(dirs), 'staging');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith('st-')) : [];
};

async function installOk(mods, ctx, dirs, version) {
  const pkg = buildPkg(mods, version);
  writeRegistry(dirs.reg, [{ pkg }], { latest: version });
  const r = await runUpdate(mods, ctx, dirs, ['--write']);
  return { r, pkg };
}

async function checkAndInstall(R, mods, ctx, tag, form) {
  const dirs = makeWorldDirs(ctx, 'a27', form);
  try {
    const pkg = buildPkg(mods, '0.1.1');
    writeRegistry(dirs.reg, [{ pkg }], { latest: '0.1.1' });
    // ① 检查(干跑)
    const before = snapTree(dirs.home);
    const dry = await runUpdate(mods, ctx, dirs, []);
    const dryDiff = compareExact(before, snapTree(dirs.home));
    if (dry.code !== 0 || !dry.out.includes('would install 0.1.1') || !dry.out.includes('decision ok'))
      R.fail(`${tag}: 检查(干跑)输出不对(退出 ${dry.code}):${dry.out.replace(/\n/g, ' | ').slice(0, 160)}`);
    else if (dryDiff.length > 0 || fs.existsSync(path.join(dirs.home, '.local')))
      R.fail(`${tag}: 检查(干跑)写了假 HOME:${dryDiff.slice(0, 3).join('; ') || '.local 出现'}`);
    else R.pass(`${tag}: 检查(干跑):would install 0.1.1、decision ok,假 HOME 零写入`);

    // ② 安装
    const inst = await runUpdate(mods, ctx, dirs, ['--write']);
    const st = fs.existsSync(path.join(dirs.home, '.local/state/agent-kit/update/state.json'))
      ? updateState(dirs)
      : {};
    const cliText = fs.existsSync(path.join(share(dirs), 'current', 'dist', 'cli.js'))
      ? fs.readFileSync(path.join(share(dirs), 'current', 'dist', 'cli.js'), 'utf8')
      : '';
    const problems = [];
    if (inst.code !== 0) problems.push(`退出 ${inst.code}`);
    if (!inst.out.includes('installed 0.1.1')) problems.push('缺 installed 0.1.1 行');
    if (inst.verifyCalls !== 1) problems.push(`验签 ${inst.verifyCalls} 次(应为 1)`);
    if (currentVersion(dirs) !== '0.1.1') problems.push(`current=${currentVersion(dirs)}`);
    if (!cliText.includes('cli 0.1.1')) problems.push('current/dist/cli.js 内容不对');
    if (st.installed?.version !== '0.1.1') problems.push('状态 installed.version 不对');
    if (st.installed?.anchor !== pkg.anchor) problems.push('状态锚点不等于 integrity.json 的 sha256');
    if (st.last_result !== 'installed') problems.push(`last_result=${st.last_result}`);
    if (stagingResidue(dirs).length > 0) problems.push('staging 残留');
    if (problems.length > 0) R.fail(`${tag}: 安装:${problems.join('; ')}::${inst.err.slice(0, 120)}`);
    else R.pass(`${tag}: 安装:current -> versions/0.1.1,锚点与状态一致,验签 1 次,无 staging 残留`);

    const again = await runUpdate(mods, ctx, dirs, ['--write']);
    if (again.code === 0 && again.out.includes('decision up_to_date') && again.verifyCalls === 0)
      R.pass(`${tag}: 再次运行 up_to_date,不再验签`);
    else R.fail(`${tag}: 再次运行应为 up_to_date 且不验签(退出 ${again.code}, 验签 ${again.verifyCalls})`);
  } finally {
    dirs.cleanup();
  }
}

async function rollbackCases(R, mods, ctx, tag, form) {
  const dirs = makeWorldDirs(ctx, 'a27r', form);
  try {
    const a = await installOk(mods, ctx, dirs, '0.1.1');
    const b = await installOk(mods, ctx, dirs, '0.1.2');
    if (a.r.code !== 0 || b.r.code !== 0 || currentVersion(dirs) !== '0.1.2') {
      R.fail(`${tag}: 回滚用例的两次安装没成功(${a.r.code}/${b.r.code}, current=${currentVersion(dirs)})`);
      return;
    }
    // 回滚不碰网络:registry 目录删掉也能回滚
    fs.rmSync(dirs.reg, { recursive: true, force: true });
    const rb = await runUpdate(mods, ctx, dirs, ['--rollback', '--write']);
    const st = updateState(dirs);
    const problems = [];
    if (rb.code !== 0) problems.push(`退出 ${rb.code}`);
    if (!rb.out.includes('did rollback from=0.1.2 to=0.1.1')) problems.push('缺 did rollback 行');
    if (currentVersion(dirs) !== '0.1.1') problems.push(`current=${currentVersion(dirs)}`);
    if (JSON.stringify(st.bad_versions) !== JSON.stringify(['0.1.2'])) problems.push(`bad_versions=${JSON.stringify(st.bad_versions)}`);
    if (st.installed?.version !== '0.1.1') problems.push('installed 不是 0.1.1');
    if (st.max_seen_version !== '0.1.2') problems.push(`max_seen_version=${st.max_seen_version}(不得降)`);
    if (problems.length > 0) R.fail(`${tag}: 回滚:${problems.join('; ')}::${rb.err.slice(0, 120)}`);
    else R.pass(`${tag}: 回滚:current 切回 0.1.1,0.1.2 进 bad_versions,max_seen 不降;registry 目录不存在也成功(零网络)`);

    // 之后不会自动装回:registry 的 latest 仍是 0.1.2
    writeRegistry(dirs.reg, [{ pkg: b.pkg }], { latest: '0.1.2' });
    const again = await runUpdate(mods, ctx, dirs, ['--write']);
    if (again.out.includes('decision verify_failed') && currentVersion(dirs) === '0.1.1')
      R.pass(`${tag}: 回滚后 latest 仍是坏版本:不再自动装回(decision verify_failed,current 不变)`);
    else R.fail(`${tag}: 回滚后被自动装回或决策不对(current=${currentVersion(dirs)}):${again.out.replace(/\n/g, ' | ').slice(0, 120)}`);
  } finally {
    dirs.cleanup();
  }

  const d2 = makeWorldDirs(ctx, 'a27n', form);
  try {
    const a = await installOk(mods, ctx, d2, '0.1.1');
    const rb = await runUpdate(mods, ctx, d2, ['--rollback', '--write']);
    if (a.r.code === 0 && rb.code === 4 && rb.err.includes('reason=no_previous') && currentVersion(d2) === '0.1.1')
      R.pass(`${tag}: 没有上一版本 => 退出 4 no_previous,current 不变`);
    else R.fail(`${tag}: 无上一版回滚应退出 4 no_previous(实 ${rb.code}, current=${currentVersion(d2)})::${rb.err.slice(0, 100)}`);
  } finally {
    d2.cleanup();
  }
}

async function outsideTmp(R, mods, ctx, tag, form) {
  const dirs = makeWorldDirs(ctx, 'a27o', form);
  const outside = mkTmp(ctx, 'a27out'); // 与 KIT_TMP 同级,在它之外
  try {
    const pkg = buildPkg(mods, '0.1.1');
    writeRegistry(outside, [{ pkg }], { latest: '0.1.1' });
    const before = snapTree(dirs.home);
    const direct = await runUpdate(mods, ctx, dirs, ['--write'], {
      env: { KIT_UPDATE_REGISTRY: `file://${outside}` },
    });
    const viaLink = path.join(dirs.kit, 'reg-link');
    fs.symlinkSync(outside, viaLink);
    const linked = await runUpdate(mods, ctx, dirs, ['--write'], {
      env: { KIT_UPDATE_REGISTRY: `file://${viaLink}` },
    });
    const diff = compareExact(before, snapTree(dirs.home));
    const bad = [];
    for (const [name, r] of [['KIT_TMP 之外', direct], ['经符号链接指到 KIT_TMP 之外', linked]]) {
      if (r.code !== 2 || !r.err.includes('UPDATE_USAGE reason=registry_fixture_outside_tmp'))
        bad.push(`${name}: 退出 ${r.code}, stderr=${r.err.replace(/\n/g, ' | ').slice(0, 100)}`);
      if (r.verifyCalls !== 0) bad.push(`${name}: 不应验签`);
    }
    if (diff.length > 0 || currentVersion(dirs) !== null) bad.push(`被拒后假 HOME 有写入:${diff.slice(0, 2).join('; ')}`);
    // 正向对照:同一份内容放进 KIT_TMP 内可用
    const ctl = path.join(dirs.kit, 'reg-inside');
    writeRegistry(ctl, [{ pkg }], { latest: '0.1.1' });
    const ok = await runUpdate(mods, ctx, dirs, [], { env: { KIT_UPDATE_REGISTRY: `file://${ctl}` } });
    if (ok.code !== 0 || !ok.out.includes('would install 0.1.1')) bad.push('正向对照失败:KIT_TMP 内的同一份夹具应可用');
    if (bad.length > 0) R.fail(`${tag}: registry 夹具守卫:${bad.join('; ')}`);
    else R.pass(`${tag}: registry 夹具在 KIT_TMP 外(直接 / 经符号链接)=> 退出 2 registry_fixture_outside_tmp,零写入;KIT_TMP 内同内容可用`);
  } finally {
    rmTmp(outside);
    dirs.cleanup();
  }
}

const WRONG_SHA512 = `sha512-${Buffer.alloc(64).toString('base64')}`;

async function integrityCases(R, mods, ctx, tag, form) {
  const cases = [
    {
      name: 'dist.integrity 与 tarball 不符',
      reason: 'integrity',
      make: () => ({ pkg: buildPkg(mods, '0.1.2'), integrity: WRONG_SHA512 }),
    },
    {
      name: '包内 integrity.json 的文件哈希对不上',
      reason: 'package',
      make: () => ({
        pkg: buildPkg(mods, '0.1.2', {
          integrity: (o) => ({
            ...o,
            files: o.files.map((f, i) => (i === 0 ? { ...f, sha256: 'f'.repeat(64) } : f)),
          }),
        }),
      }),
    },
  ];
  for (const c of cases) {
    const dirs = makeWorldDirs(ctx, 'a27i', form);
    try {
      const first = await installOk(mods, ctx, dirs, '0.1.1');
      if (first.r.code !== 0 || currentVersion(dirs) !== '0.1.1') {
        R.fail(`${tag}: 完整性用例的首次安装没成功(退出 ${first.r.code})`);
        continue;
      }
      const treeBefore = versionsOf(dirs);
      const v = c.make();
      writeRegistry(dirs.reg, [{ pkg: v.pkg, ...(v.integrity ? { integrity: v.integrity } : {}) }], { latest: '0.1.2' });
      const r = await runUpdate(mods, ctx, dirs, ['--write']);
      const st = updateState(dirs);
      const bad = [];
      if (r.code !== 1) bad.push(`退出 ${r.code}(应为 1)`);
      if (!r.err.includes(`UPDATE_VERIFY_FAILED reason=${c.reason}`)) bad.push(`stderr 缺 UPDATE_VERIFY_FAILED reason=${c.reason}`);
      if (currentVersion(dirs) !== '0.1.1') bad.push(`current 变成了 ${currentVersion(dirs)}`);
      if (st.installed?.version !== '0.1.1') bad.push('状态 installed 变了');
      if (JSON.stringify(versionsOf(dirs)) !== JSON.stringify(treeBefore)) bad.push(`versions 目录变了:${versionsOf(dirs).join(',')}`);
      if (stagingResidue(dirs).length > 0) bad.push('staging 残留');
      if (!st.bad_versions?.includes('0.1.2')) bad.push('0.1.2 没进 bad_versions');
      if (bad.length > 0) R.fail(`${tag}: ${c.name}:${bad.join('; ')}`);
      else R.pass(`${tag}: ${c.name} => 退出 1 reason=${c.reason},current 仍为 0.1.1,新版本不落盘,拉黑`);
    } finally {
      dirs.cleanup();
    }
  }
}

async function a27(argv) {
  const R = new Reporter('A27');
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
  const tmp = mkTmp(ctx, 'a27n');
  try {
    const net = await installNoNet(ctx, tmp);
    if (!net.controlOk) {
      R.notRun('no-net 垫片没有拦住对照 fetch(无法证明零网络)');
      return R.exit();
    }
    for (const form of ['real', 'link']) {
      const tag = form === 'link' ? '符号链接' : '真实路径';
      await checkAndInstall(R, mods, ctx, tag, form);
      await rollbackCases(R, mods, ctx, tag, form);
      await outsideTmp(R, mods, ctx, tag, form);
      await integrityCases(R, mods, ctx, tag, form);
    }
    const hits = net.blocked();
    if (hits.length === 0) R.pass('零真实网络(no-net 垫片未被触发)');
    else R.fail(`触碰了网络 API:${hits.slice(0, 2).join(' | ')}`);
  } finally {
    rmTmp(tmp);
  }
  const n = guard.diff(homeBefore, guard.take());
  if (n === 0) R.pass('真实 HOME 的受管路径与套件 share/state/config 目录前后无差异');
  else
    R.attribute(
      `真实 HOME 出现 ${n} 处差异;请用 ops/zero-write-check.sh 归因(多半是其它进程的写入,update 全程只用 --home 假 HOME)`,
    );
  return R.exit();
}

await runMain(import.meta.url, 'A27', () => a27(process.argv.slice(2)));

// A11 供应链(D §8/§9 的 P0 子集):精确版本、lockfile 入库、--ignore-scripts 可装、audit 无 high/critical、许可证清单。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Reporter,
  cleanEnv,
  copyFiles,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
} from './common.mjs';

const EXACT = /^\d+\.\d+\.\d+$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
export const MAX_DIRECT = 12;
/** 许可证黑名单(强 copyleft / 无许可);命中即违规。其它非常见者只列入清单供人工看。 */
const DENY_LICENSE =
  /(^|[^A-Za-z])(AGPL|GPL|LGPL|SSPL|BUSL|Commons-Clause|UNLICENSED|UNKNOWN|SEE LICENSE)/i;
const COMMON_LICENSE =
  /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Python-2\.0|MIT-0|Unlicense|CC-BY-4\.0|Zlib)$/;

/** 返回 { problems[], direct[] }。 */
export function checkManifest(pkg) {
  const problems = [];
  const direct = [];
  for (const f of DEP_FIELDS) {
    for (const [name, v] of Object.entries(pkg[f] ?? {})) {
      direct.push(name);
      if (!EXACT.test(String(v))) problems.push(`${f}.${name} = ${JSON.stringify(v)} 不是精确版本`);
    }
  }
  const ov = {
    ...(pkg.overrides ?? {}),
    ...(pkg.pnpm?.overrides ?? {}),
    ...(pkg.resolutions ?? {}),
  };
  for (const [name, v] of Object.entries(ov))
    if (!EXACT.test(String(v)))
      problems.push(`overrides.${name} = ${JSON.stringify(v)} 不是精确版本`);
  for (const [name, v] of Object.entries(pkg.peerDependencies ?? {})) {
    if (/(^|[\s|])(latest|\*)($|[\s|])/.test(String(v)))
      problems.push(`peerDependencies.${name} = ${JSON.stringify(v)} 含 latest/*`);
  }
  if (!pkg.packageManager || !/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager))
    problems.push(
      `packageManager 必须固定为 pnpm@x.y.z(实际 ${JSON.stringify(pkg.packageManager)})`,
    );
  return { problems, direct };
}

/** pnpm audit --json 输出 => { high, critical, parsed }。 */
export function parseAudit(stdout) {
  try {
    const j = JSON.parse(stdout);
    const v = j?.metadata?.vulnerabilities;
    if (!v || typeof v !== 'object') return { parsed: false };
    return {
      parsed: true,
      high: Number(v.high ?? 0),
      critical: Number(v.critical ?? 0),
      total: Object.values(v).reduce((a, b) => a + Number(b || 0), 0),
    };
  } catch {
    return { parsed: false };
  }
}

/** 从 node_modules/.pnpm 读已安装包的 name/version/license。 */
export function collectLicenses(nodeModules) {
  const out = [];
  const pnpmDir = path.join(nodeModules, '.pnpm');
  const roots = [];
  if (fs.existsSync(pnpmDir)) {
    for (const d of fs.readdirSync(pnpmDir)) {
      const nm = path.join(pnpmDir, d, 'node_modules');
      if (fs.existsSync(nm)) roots.push(nm);
    }
  } else if (fs.existsSync(nodeModules)) roots.push(nodeModules);
  const seen = new Set();
  for (const nm of roots) {
    for (const n of fs.readdirSync(nm)) {
      if (n.startsWith('.')) continue;
      const pkgDirs = n.startsWith('@')
        ? fs.readdirSync(path.join(nm, n)).map((x) => path.join(nm, n, x))
        : [path.join(nm, n)];
      for (const pd of pkgDirs) {
        const pj = path.join(pd, 'package.json');
        if (!fs.existsSync(pj)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
          const key = `${j.name}@${j.version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lic =
            typeof j.license === 'string'
              ? j.license
              : (j.license?.type ??
                (Array.isArray(j.licenses)
                  ? j.licenses.map((l) => l.type).join(' OR ')
                  : 'UNKNOWN'));
          out.push({ name: j.name, version: j.version, license: lic || 'UNKNOWN' });
        } catch {
          /* 坏 package.json 忽略 */
        }
      }
    }
  }
  return out.sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1));
}

async function a11(argv) {
  const R = new Reporter('A11');
  const { flags } = parseCommon(argv, {
    value: ['licenses-out', 'pnpm'],
    bool: ['skip-install', 'skip-audit'],
  });
  const ctx = makeCtx(flags);
  const pnpm = flags.pnpm ?? 'pnpm';
  const pj = path.join(ctx.root, 'package.json');
  if (!fs.existsSync(pj)) {
    R.rejected('缺 package.json');
    return R.exit();
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
  } catch {
    R.rejected('package.json 不是合法 JSON');
    return R.exit();
  }
  const { problems, direct } = checkManifest(pkg);
  if (problems.length) for (const p of problems) R.fail(p);
  else R.pass(`${direct.length} 个直接依赖全部是精确版本(无 ^ ~ latest *),packageManager 已固定`);
  if (direct.length === 0) R.fail('没有任何直接依赖,版本检查空跑');

  // 直接依赖数 ≤ 12,超出须在 docs/deps.md 逐个说明
  if (direct.length > MAX_DIRECT) {
    const depsDoc = path.join(ctx.root, 'docs', 'deps.md');
    const text = fs.existsSync(depsDoc) ? fs.readFileSync(depsDoc, 'utf8') : '';
    const missing = direct.filter((d) => !text.includes('`' + d + '`'));
    if (missing.length)
      R.fail(
        `直接依赖 ${direct.length} > ${MAX_DIRECT},docs/deps.md 缺这些依赖的说明:${missing.join(', ')}`,
      );
    else R.pass(`直接依赖 ${direct.length} > ${MAX_DIRECT},docs/deps.md 已逐个说明`);
  } else R.pass(`直接依赖 ${direct.length} <= ${MAX_DIRECT}`);

  // lockfile 入库
  const lock = path.join(ctx.root, 'pnpm-lock.yaml');
  if (!fs.existsSync(lock)) R.fail('缺 pnpm-lock.yaml');
  else {
    const g = run('git', ['-C', ctx.root, 'ls-files', '--error-unmatch', 'pnpm-lock.yaml'], {
      env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
    });
    if (g.status === 0) R.pass('pnpm-lock.yaml 已被 git 跟踪');
    else if (fs.existsSync(path.join(ctx.root, '.git')))
      R.fail('pnpm-lock.yaml 存在但没有被 git 跟踪');
    else R.notRun('不是 git 仓库,无法确认 lockfile 已提交');
  }

  const tmp = mkTmp(ctx, 'a11');
  let installedNm = null;
  try {
    // --ignore-scripts 安装(临时目录,只复制 package.json + lock)
    if (!flags.skipInstall) {
      const dir = path.join(tmp, 'install');
      copyFiles(
        ctx.root,
        ['package.json', 'pnpm-lock.yaml'].filter((f) => fs.existsSync(path.join(ctx.root, f))),
        dir,
      );
      const sb = sandbox(tmp);
      const r = run(
        pnpm,
        ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'],
        {
          cwd: dir,
          env: { ...process.env, KIT_TMP: sb.kit, CI: '1' },
        },
      );
      if (r.spawnFailed) R.notRun(`找不到 ${pnpm}`);
      else if (r.status !== 0)
        R.fail(
          `pnpm install --frozen-lockfile --ignore-scripts 失败(exit ${r.status}):${(r.stderr || r.stdout).slice(-200)}`,
        );
      else {
        R.pass('--frozen-lockfile --ignore-scripts 可安装');
        installedNm = path.join(dir, 'node_modules');
      }
    }

    // audit(需要网络;失败 => 4)
    if (!flags.skipAudit) {
      const r = run(pnpm, ['audit', '--prod', '--json'], {
        cwd: ctx.root,
        env: { ...process.env, CI: '1' },
        timeoutMs: 120_000,
      });
      const a = parseAudit(r.stdout);
      if (r.spawnFailed || r.status === null) R.notRun('pnpm audit 无法执行(未安装/超时)');
      else if (!a.parsed)
        R.notRun(
          `pnpm audit 没有给出可解析结果(多半是网络不可用,需人工补跑):${(r.stderr || r.stdout).slice(0, 160).replace(/\s+/g, ' ')}`,
        );
      else if (a.high + a.critical > 0)
        R.fail(`pnpm audit --prod 有 high=${a.high} critical=${a.critical}`);
      else R.pass(`pnpm audit --prod 无 high/critical(总漏洞数 ${a.total})`);
    }

    // 许可证清单
    // 优先扫描刚装出来的依赖树(源工作树的 node_modules 可能陈旧)
    const nm =
      installedNm && fs.existsSync(installedNm) ? installedNm : path.join(ctx.root, 'node_modules');
    if (!fs.existsSync(nm)) R.notRun('node_modules 不存在,无法生成许可证清单(先装依赖)');
    else {
      const lics = collectLicenses(nm);
      if (lics.length === 0) R.notRun('node_modules 里没有读到任何包,许可证清单空跑');
      else {
        const outFile = path.resolve(
          flags.licensesOut ?? path.join(ctx.root, '.state', 'accept', 'licenses.json'),
        );
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(lics, null, 2) + '\n');
        const denied = lics.filter((l) => DENY_LICENSE.test(l.license));
        const uncommon = lics.filter(
          (l) => !COMMON_LICENSE.test(l.license) && !DENY_LICENSE.test(l.license),
        );
        if (denied.length)
          R.fail(
            `禁用许可证:${denied
              .map((l) => `${l.name}@${l.version}(${l.license})`)
              .slice(0, 5)
              .join(', ')}`,
          );
        else
          R.pass(
            `许可证清单 ${lics.length} 个包落盘 ${path.relative(ctx.root, outFile) || outFile},无 copyleft/无许可`,
          );
        if (uncommon.length)
          R.info(
            `需人工看一眼的非常见许可证 ${uncommon.length} 个:${uncommon
              .slice(0, 5)
              .map((l) => `${l.name}(${l.license})`)
              .join(', ')}`,
          );
      }
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A11', () => a11(process.argv.slice(2)));

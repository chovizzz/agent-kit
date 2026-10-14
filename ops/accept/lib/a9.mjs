// A9 写入只经唯一出口:独立静态扫描 + eslint + vitest test/io。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Reporter,
  cleanEnv,
  listTestFiles,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  runMain,
  vitestStep,
} from './common.mjs';

const ALLOWED = new Set(['src/io/safe-fs.ts', 'src/io/read-fs.ts', 'src/io/home-fs.ts']);
const FS_MOD = String.raw`(?:node:)?fs(?:\/promises)?`;
const PATTERNS = [
  new RegExp(String.raw`\bfrom\s*['"\`]${FS_MOD}['"\`]`),
  new RegExp(String.raw`\bimport\s*\(\s*['"\`]${FS_MOD}['"\`]`),
  new RegExp(String.raw`\brequire\s*\(\s*['"\`]${FS_MOD}['"\`]`),
  new RegExp(String.raw`\bimport\s*['"\`]${FS_MOD}['"\`]`),
  /process\.binding\s*\(/,
  /process\.getBuiltinModule\s*\(/,
];

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** 扫描 root 下 cli.ts / src / adapters 的源码;返回 { scanned, allowedHits, violations[] }。 */
export function scanSources(root) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const n of fs.readdirSync(abs)) {
      const r = `${rel}/${n}`;
      const st = fs.statSync(path.join(root, r));
      if (st.isDirectory()) {
        if (n !== 'node_modules') walk(r);
      } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(n)) files.push(r);
    }
  };
  walk('src');
  walk('adapters');
  if (fs.existsSync(path.join(root, 'cli.ts'))) files.push('cli.ts');
  const violations = [];
  let allowedHits = 0;
  for (const f of files) {
    const text = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
    const hit = PATTERNS.find((re) => re.test(text));
    if (!hit) continue;
    if (ALLOWED.has(f) && PATTERNS.slice(0, 4).some((re) => re.test(text))) allowedHits++;
    else violations.push(f);
  }
  return { scanned: files.length, allowedHits, violations };
}

async function a9(argv) {
  const R = new Reporter('A9');
  const { flags } = parseCommon(argv, { bool: ['no-lint', 'no-vitest'] });
  const ctx = makeCtx(flags);
  const scan = scanSources(ctx.root);
  if (scan.scanned === 0) R.notRun('没有找到任何源码(src/ adapters/ cli.ts),扫描空跑');
  else if (scan.allowedHits < 1)
    R.fail('扫描器失明:连 src/io/safe-fs.ts / read-fs.ts 里的 fs 导入都没扫到');
  else if (scan.violations.length)
    R.fail(`这些文件越过唯一出口导入了 fs:${scan.violations.join(', ')}`);
  else
    R.pass(
      `静态扫描 ${scan.scanned} 个源文件:除 safe-fs/read-fs 外无 fs 导入(扫描器在放行文件里命中 ${scan.allowedHits} 处,非空跑)`,
    );

  const tmp = mkTmp(ctx, 'a9');
  try {
    if (!flags.noLint) {
      const eslint = path.join(ctx.root, 'node_modules', '.bin', 'eslint');
      if (!fs.existsSync(eslint)) R.notRun(`找不到 eslint:${eslint}`);
      else {
        const r = run(eslint, ['.'], { cwd: ctx.root, env: cleanEnv({ KIT_TMP: tmp }) });
        if (r.spawnFailed || r.status === null) R.notRun('eslint 未能正常结束');
        else if (r.status !== 0)
          R.fail(`eslint 退出 ${r.status} :: ${r.stdout.split('\n').slice(0, 6).join(' | ')}`);
        else R.pass('eslint . 零违规');
      }
    }
    if (!flags.noVitest) {
      const need = listTestFiles(ctx.root, 'test/io');
      if (!need.includes('test/io/safe-fs.test.ts'))
        R.fail('缺 test/io/safe-fs.test.ts(向 HOME/仓库外写入会抛错的单测)');
      vitestStep(R, ctx, tmp, 'vitest test/io test/lint', ['test/io', 'test/lint'], {
        files: { 'test/io/safe-fs.test.ts': { min: 5, controls: 0 } },
        dirs: ['test/io', 'test/lint'],
      });
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A9', () => a9(process.argv.slice(2)));

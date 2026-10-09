// A15 personal 层不进 core 输出:在隔离副本里重新构建,逐文件核对 out/manifest.json;并核对仓库里已提交的 out/。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT_STUB,
  Reporter,
  cleanEnv,
  copyFiles,
  distSrc,
  listRepoFiles,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
  sha256,
  treeHash,
  vitestStep,
} from './common.mjs';

/** 校验一份 out/ 目录 + manifest(schema 由调用方给)。返回 problems[]。 */
export function checkManifest(outDir, ManifestSchema) {
  const problems = [];
  const mf = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mf)) return ['缺 out/manifest.json'];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch {
    return ['manifest.json 不是合法 JSON'];
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success)
    return [
      `manifest.json 不符合 ManifestSchema:${parsed.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join('.')}:${i.message}`)
        .join('; ')}`,
    ];
  const m = parsed.data;
  if (m.files.length === 0) problems.push('manifest.files 为空(空产物不能证明 personal 没进输出)');
  const seen = new Set();
  for (const f of m.files) {
    if (seen.has(f.path)) problems.push(`manifest 路径重复:${f.path}`);
    seen.add(f.path);
    if (
      f.path.startsWith('/') ||
      f.path.split('/').some((s) => s === '..' || s === '.' || s === '') ||
      f.path.includes('\\')
    )
      problems.push(`manifest 路径不安全:${f.path}`);
    for (const a of f.atoms)
      if (a.layer === 'personal') problems.push(`${f.path}: 来源原子 ${a.id} 是 layer=personal`);
    const abs = path.join(outDir, ...f.path.split('/'));
    if (!fs.existsSync(abs)) problems.push(`manifest 列了 ${f.path} 但 out/ 里没有`);
    else if (sha256(fs.readFileSync(abs)) !== f.sha256)
      problems.push(`${f.path}: sha256 与落盘内容不一致`);
  }
  const onDisk = [];
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(outDir, rel))) {
      const r = rel === '' ? n : `${rel}/${n}`;
      const st = fs.lstatSync(path.join(outDir, r));
      if (st.isDirectory()) walk(r);
      else if (r !== 'manifest.json') onDisk.push(r);
    }
  };
  walk('');
  for (const f of onDisk) if (!seen.has(f)) problems.push(`out/ 里有文件 ${f} 但 manifest 没登记`);
  const skipped = m.skippedLayers.find((s) => s.layer === 'personal');
  if (!skipped || !skipped.reason.trim())
    problems.push('manifest.skippedLayers 缺 personal 层已跳过的说明(P2 才渲染)');
  return problems;
}

async function a15(argv) {
  const R = new Reporter('A15');
  const { flags } = parseCommon(argv, { bool: ['no-vitest'], value: ['schema-src'] });
  const ctx = makeCtx(flags);
  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 CLI:${ctx.cli}`);
    return R.exit();
  }
  let ManifestSchema;
  try {
    ManifestSchema = (
      await import(
        pathToFileURL(path.join(flags.schemaSrc ?? distSrc(ctx), 'contracts', 'render.js')).href
      )
    ).ManifestSchema;
  } catch (e) {
    R.notRun(`取不到 ManifestSchema(先 pnpm run build):${String(e.message).slice(0, 100)}`);
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a15');
  try {
    // 1) 隔离副本里重新构建(不信任仓库里可能陈旧的 out/)
    const files = listRepoFiles(ctx.root, {
      exclude: ['out', 'dist', 'node_modules', '.state', '.git'],
    });
    const copy = path.join(tmp, 'repo');
    copyFiles(ctx.root, files, copy);
    const sb = sandbox(tmp);
    const r = run(ctx.node, [ctx.cli, '--root', copy, 'build'], {
      cwd: copy,
      env: cleanEnv({ HOME: sb.home, KIT_TMP: sb.kit }),
    });
    let fresh = null;
    if (r.spawnFailed || r.status === null) R.notRun('build 未能正常结束');
    else if (r.status === EXIT_STUB)
      R.notRun('build 是命令桩(退出 64)或 manifest 尚未接线,无法核对 out/(待 B19)');
    else if (r.status !== 0) R.fail(`build 退出 ${r.status} :: ${r.stderr.slice(0, 200)}`);
    else if (!fs.existsSync(path.join(copy, 'out', 'manifest.json')))
      R.fail('build 成功但没有产出 out/manifest.json(渲染器未输出清单,待 B19 接线)');
    else {
      const problems = checkManifest(path.join(copy, 'out'), ManifestSchema);
      if (problems.length) for (const p of problems) R.fail(`新构建的 out/:${p}`);
      else
        R.pass(
          '新构建的 out/:manifest 通过 schema,personal 来源为 0,文件集合与哈希一一对应,含 personal 跳过说明',
        );
      fresh = path.join(copy, 'out');
    }

    // 2) 仓库里已提交的 out/
    const committed = path.join(ctx.root, 'out');
    if (fs.existsSync(committed)) {
      const problems = checkManifest(committed, ManifestSchema);
      if (problems.length) for (const p of problems) R.fail(`仓库 out/:${p}`);
      else R.pass('仓库 out/:manifest 通过核对');
      if (fresh && problems.length === 0) {
        if (treeHash(committed).hash === treeHash(fresh).hash)
          R.pass('仓库 out/ 与重新构建的结果逐字节一致(没有陈旧产物)');
        else R.fail('仓库 out/ 与重新构建的结果不一致(out/ 入 git,应随源码更新)');
      }
    } else if (fresh) {
      R.fail('仓库根没有 out/:out/ 要入 git(plan A15),A15 需要核对已提交的产物');
    } else R.info('仓库根没有 out/(build 未接线,上面已记为未执行)');
    if (fresh && fs.existsSync(committed) && fs.existsSync(path.join(ctx.root, '.git'))) {
      const g = run('git', ['-C', ctx.root, 'ls-files', '--', 'out/manifest.json'], {
        env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
      });
      if (g.status !== 0 || g.stdout.trim() === '')
        R.fail('out/manifest.json 没有被 git 跟踪(out/ 应入 git)');
    }

    // 3) 正向控制:personal 原子出现在合并结果里、但进输出会被拒(vitest 里的两条关键用例必须真的跑过)
    if (!flags.noVitest) {
      vitestStep(
        R,
        ctx,
        tmp,
        'vitest 正向控制(合并结果里有 personal;进输出即抛错、org 通过)',
        [
          'test/merge/merge.test.ts',
          'test/render-core/out-layout.test.ts',
          'test/render-core/core.test.ts',
        ],
        {
          titles: [
            { file: 'test/merge/merge.test.ts', includes: 'personal 原子出现在合并结果里' },
            { file: 'test/render-core/out-layout.test.ts', includes: 'personal 原子进输出' },
            { file: 'test/render-core/core.test.ts', includes: 'personal / 未知原子进输出' },
          ],
        },
      );
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A15', () => a15(process.argv.slice(2)));

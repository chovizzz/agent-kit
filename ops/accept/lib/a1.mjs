// A1 确定性:四种环境组合下 build 的 out/ 树哈希全相等,且 out/ 内无时间戳/绝对路径/用户名。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXIT_STUB,
  Reporter,
  cleanEnv,
  copyFiles,
  listRepoFiles,
  runMain,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  sandbox,
  treeHash,
} from './common.mjs';

const ISO_TS = /20[0-9]{2}-[0-9]{2}-[0-9]{2}T/;

export function scanOut(outDir, forbidden) {
  const hits = [];
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(outDir, rel))) {
      const r = rel === '' ? n : `${rel}/${n}`;
      const abs = path.join(outDir, r);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(r);
      else if (st.isFile() || st.isSymbolicLink()) {
        const text = st.isFile() ? fs.readFileSync(abs, 'latin1') : fs.readlinkSync(abs);
        const names = [r];
        for (const s of [...names, text]) {
          if (ISO_TS.test(s)) hits.push(`${r}: 疑似时间戳`);
          for (const f of forbidden)
            if (f && s.includes(f))
              hits.push(
                `${r}: 含 ${f.length > 3 ? '禁用串' : f}(${JSON.stringify(f).slice(0, 40)})`,
              );
        }
      }
    }
  };
  walk('');
  return [...new Set(hits)];
}

export const ENVS = [
  { name: 'default', env: {}, sub: null },
  { name: 'tz-shanghai', env: { TZ: 'Asia/Shanghai' }, sub: null },
  { name: 'lang-c', env: { LANG: 'C', LC_ALL: 'C' }, sub: null },
  { name: 'subdir-root', env: {}, sub: 'docs' },
];

async function a1(argv) {
  const R = new Reporter('A1');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);
  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 CLI:${ctx.cli}(先 pnpm run build)`);
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a1');
  try {
    const files = listRepoFiles(ctx.root, {
      exclude: ['out', 'dist', 'node_modules', '.state', '.git'],
    });
    if (files.length === 0) {
      R.notRun('仓库文件清单为空');
      return R.exit();
    }
    const sb = sandbox(tmp);
    // 每次运行用路径长度/名字都不同的副本,绝对路径若泄进 out/ 会让哈希不同
    const runs = [...ENVS, { name: 'default-again', env: {}, sub: null }];
    const hashes = [];
    let notRun = false;
    for (const [i, e] of runs.entries()) {
      const copy = path.join(tmp, `${'x'.repeat(i * 3 + 1)}-${e.name}`, 'repo');
      copyFiles(ctx.root, files, copy);
      if (e.sub) fs.mkdirSync(path.join(copy, e.sub), { recursive: true });
      const cwd = e.sub ? path.join(copy, e.sub) : copy;
      const r = run(ctx.node, [ctx.cli, '--root', copy, 'build'], {
        cwd,
        env: cleanEnv({ HOME: sb.home, KIT_TMP: sb.kit, ...e.env }),
      });
      if (r.spawnFailed) {
        R.notRun(`${e.name}: 无法启动 CLI`);
        notRun = true;
        break;
      }
      if (r.status === EXIT_STUB) {
        R.notRun(`${e.name}: build 是命令桩(退出 64),确定性无从判断`);
        notRun = true;
        break;
      }
      if (r.status !== 0) {
        R.fail(`${e.name}: build 退出 ${r.status} :: ${r.stderr.slice(0, 300)}`);
        continue;
      }
      const outDir = path.join(copy, 'out');
      if (!fs.existsSync(outDir)) {
        R.fail(`${e.name}: build 成功但没有 out/`);
        continue;
      }
      const th = treeHash(outDir);
      if (th.count === 0) {
        R.fail(`${e.name}: out/ 是空的(空树不能证明确定性)`);
        continue;
      }
      hashes.push({ name: e.name, ...th });
      R.info(`${e.name}: ${th.hash.slice(0, 16)} (${th.count} 个文件)`);
      const forbidden = [
        '/Users/',
        process.env.USER,
        os.userInfo().username,
        ctx.root,
        copy,
        tmp,
        os.tmpdir() === '/tmp' ? '' : os.tmpdir(),
      ].filter((s) => s && s.length >= 3);
      const hits = scanOut(outDir, [...new Set(forbidden)]);
      if (hits.length)
        R.fail(`${e.name}: out/ 含时间戳/绝对路径/用户名:${hits.slice(0, 5).join(' | ')}`);
      else R.pass(`${e.name}: out/ 无时间戳/绝对路径/用户名`);
    }
    if (!notRun && hashes.length === runs.length) {
      const distinct = new Set(hashes.map((h) => h.hash));
      if (distinct.size === 1) R.pass(`${runs.length} 次构建(含 4 种环境)树哈希全等`);
      else {
        R.fail(`树哈希不一致:${hashes.map((h) => `${h.name}=${h.hash.slice(0, 12)}`).join(' ')}`);
        const base = hashes[0].entries;
        for (const h of hashes.slice(1)) {
          const diff = h.entries.filter((l) => !base.includes(l)).slice(0, 3);
          if (diff.length)
            R.info(
              `  ${h.name} 相对 default 不同的条目(前 3):${diff.map((d) => d.split('\t')[0]).join(', ')}`,
            );
        }
      }
    }
    return R.exit();
  } finally {
    rmTmp(tmp);
  }
}

await runMain(import.meta.url, 'A1', () => a1(process.argv.slice(2)));

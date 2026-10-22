// A10 隐私卫生:.state/ 0700/0600、git 不含 .state / 会话原文、reader-samples 只含哈希与行数、全量脱敏扫描零命中。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT_STUB,
  Reporter,
  cleanEnv,
  distSrc,
  listRepoFiles,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
  vitestStep,
} from './common.mjs';

/** .state 下由 ops 工具自己建的子目录(不属于产品写出口),不做 0700/0600 判定,但在输出里点名。 */
export const OPS_TOOL_DIRS = ['test-tmp', 'accept-tmp', 'zero-write', 'accept'];

export function modeProblems(dir, { skipTop = [] } = {}) {
  const problems = [];
  let checked = 0;
  const walk = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      problems.push(`${rel || '.'}: 符号链接`);
      return;
    }
    const mode = st.mode & 0o777;
    checked++;
    if (st.isDirectory()) {
      if (mode !== 0o700) problems.push(`${rel || '.'}: 目录权限 ${mode.toString(8)} != 700`);
      for (const n of fs.readdirSync(abs)) {
        if (rel === '' && skipTop.includes(n)) continue;
        walk(path.join(abs, n), rel === '' ? n : `${rel}/${n}`);
      }
    } else if (mode !== 0o600) problems.push(`${rel}: 文件权限 ${mode.toString(8)} != 600`);
  };
  walk(dir, '');
  return { problems, checked };
}

export function checkSamplesFile(text) {
  const problems = [];
  let rows = 0;
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    rows++;
    if (!/^(claude|codex|pi|kimi)\t[0-9a-f]{16}\t\d+$/.test(raw))
      problems.push(`第 ${i + 1} 行不是 <agent>\\t<16 位十六进制>\\t<行数>`);
  }
  if (rows === 0) problems.push('没有任何数据行');
  return { problems, rows };
}

export function isText(buf) {
  return !buf.subarray(0, 8192).includes(0);
}

/**
 * 仓库文档与种子里引用的公开主机(docs/spikes/gitleaks.md、src/redact/seeds.ts 的参考链接)。
 * 只放行这几个域名的 URL;IPv4 字面量不放行(测试里的回环地址改为运行时拼接)。新增命中仍会被拦。
 */
export const PUBLIC_DOC_HOSTS = [
  'github.com',
  'pkg.go.dev',
  'developer.mozilla.org',
  'www.npmjs.com',
  // 公开 npm registry 地址(发布工作流与 package.json 的 publishConfig);不是个人数据面。
  'registry.npmjs.org',
];

async function loadScanner(ctx, allowHosts = []) {
  const dist = distSrc(ctx);
  const red = await import(pathToFileURL(path.join(dist, 'redact', 'redactor.js')).href);
  const chunk = await import(pathToFileURL(path.join(dist, 'redact', 'chunk.js')).href);
  const seeds = await import(pathToFileURL(path.join(dist, 'redact', 'seeds.js')).href);
  const redactor = red.createRedactor(
    { sensitive_words: [], allowed_url_hosts: allowHosts, timeout_ms: 10_000 },
    { internalDomains: [] },
  );
  const scanText = (text) => {
    const hits = [];
    let failure = null;
    for (const c of chunk.chunkForCheck(text, 65536, 2048)) {
      const d = redactor.pass2Detail(c.text);
      if (d.failure !== undefined) failure = d.failure;
      for (const h of d.hits) hits.push(h.rule);
    }
    return { hits, failure };
  };
  const plain = seeds.buildSeeds().find((s) => s.category === 'plain' && s.tier === 'recognized');
  return { scanText, plantText: plain?.input ?? null };
}

async function a10(argv) {
  const R = new Reporter('A10');
  const { flags } = parseCommon(argv, { bool: ['no-vitest', 'no-scan'], multi: ['allow-host'] });
  const ctx = makeCtx(flags);
  const tmp = mkTmp(ctx, 'a10');
  let probeBase = null;
  try {
    // 1) 仓库内已有的 .state/
    const stateDir = path.join(ctx.root, '.state');
    if (fs.existsSync(stateDir)) {
      const { problems, checked } = modeProblems(stateDir, { skipTop: OPS_TOOL_DIRS });
      if (problems.length) R.fail(`.state 权限不符:${problems.slice(0, 5).join(' | ')}`);
      else
        R.pass(
          `.state 现有 ${checked} 项权限均为 0700/0600(ops 工具目录 ${OPS_TOOL_DIRS.join('/')} 除外)`,
        );
    } else R.info('.state 不存在(由下面的主动探针补位)');

    // 2) 主动探针:产品自己建 state 时的权限(防"没有 .state 就空通过")
    if (!fs.existsSync(ctx.cli)) R.notRun(`找不到 CLI:${ctx.cli}`);
    else {
      // 探针的假 HOME 必须在仓库**外**:产品的路径守卫(paths.ts assertNotHomeOrAncestor)会拒绝
      // 「仓库根是 HOME 的上级」,而 ctx.tmpBase 在仓库的 .state/ 里。守卫是对的,不能放宽。
      probeBase = fs.realpathSync(
        fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'a10-probe-')),
      );
      const probeSbx = sandbox(probeBase);
      const probeState = path.join(probeSbx.kit, 'probe-state');
      const src = path.join(probeBase, 'probe-source');
      fs.mkdirSync(src, { recursive: true });
      const r = run(
        ctx.node,
        [
          ctx.cli,
          '--root',
          ctx.root,
          'signals',
          'collect',
          '--agent',
          'claude',
          '--allow-project',
          'a10-probe',
          '--source',
          src,
        ],
        {
          cwd: ctx.root,
          env: cleanEnv({
            HOME: probeSbx.home,
            KIT_TMP: probeSbx.kit,
            KIT_STATE_DIR: probeState,
          }),
        },
      );
      if (r.status === EXIT_STUB) R.notRun('signals collect 是命令桩,无法探针 state 权限');
      else if (r.status !== 0)
        R.fail(`探针 signals collect 退出 ${r.status} :: ${r.stderr.slice(0, 200)}`);
      else if (!fs.existsSync(probeState))
        R.fail('探针没有产生 state 目录(盐文件应在非 dry 模式创建;探针空跑)');
      else {
        const { problems, checked } = modeProblems(probeState);
        if (checked < 2) R.fail('探针产物不足(只有目录没有文件,权限判定空跑)');
        else if (problems.length) R.fail(`产品建的 state 权限不符:${problems.join(' | ')}`);
        else R.pass(`探针:产品建的 state(${checked} 项)权限为 0700/0600`);
      }
    }

    // 3) git 清单
    const files = listRepoFiles(ctx.root, { exclude: ['node_modules', 'dist'] });
    if (files.length === 0) R.notRun('文件清单为空');
    else {
      const stateTracked = files.filter((f) => f === '.state' || f.startsWith('.state/'));
      if (stateTracked.length) R.fail(`git 清单含 .state/:${stateTracked.slice(0, 3).join(', ')}`);
      else R.pass('git 清单不含 .state/');
      const jsonl = files.filter((f) => /\.jsonl$/i.test(f));
      if (jsonl.length) R.fail(`仓库含 .jsonl(疑似会话原文):${jsonl.slice(0, 3).join(', ')}`);
      else R.pass('仓库不含任何 .jsonl');
    }

    // 4) reader-samples.txt
    const samples = path.join(ctx.root, 'inventory', 'reader-samples.txt');
    if (!fs.existsSync(samples)) R.fail('缺 inventory/reader-samples.txt');
    else {
      const { problems, rows } = checkSamplesFile(fs.readFileSync(samples, 'utf8'));
      if (problems.length) R.fail(`reader-samples.txt:${problems.slice(0, 3).join(' | ')}`);
      else R.pass(`reader-samples.txt ${rows} 行只含 agent/路径哈希/行数`);
    }

    // 5) 全量脱敏扫描(无 fixture 豁免)
    if (!flags.noScan && files.length > 0) {
      let scanner;
      try {
        scanner = await loadScanner(ctx, [...PUBLIC_DOC_HOSTS, ...(flags.allowHost ?? [])]);
      } catch (e) {
        R.notRun(`脱敏扫描器不可用:${String(e.message).slice(0, 120)}`);
      }
      if (scanner) {
        if (!scanner.plantText) R.notRun('取不到植入用的种子,扫描器无正向对照');
        else {
          const planted = scanner.scanText(`before ${scanner.plantText} after`);
          if (planted.hits.length === 0)
            R.fail('扫描器正向对照失败:植入的种子文本没被检出(扫描器失明)');
          else {
            let scanned = 0;
            const bad = [];
            for (const f of files) {
              const buf = fs.readFileSync(path.join(ctx.root, f));
              if (!isText(buf)) continue;
              scanned++;
              const res = scanner.scanText(buf.toString('utf8'));
              if (res.hits.length) bad.push(`${f}(${[...new Set(res.hits)].join(',')})`);
              else if (res.failure) bad.push(`${f}(扫描失败:${res.failure})`);
            }
            if (bad.length)
              R.fail(`脱敏扫描命中 ${bad.length} 个文件:${bad.slice(0, 40).join(' | ')}`);
            else R.pass(`脱敏扫描 ${scanned} 个文本文件零命中(无豁免;植入正向对照已检出)`);
          }
        }
      }
    }

    // 6) 落盘权限的单测在 vitest 里(含信号文件)
    if (!flags.noVitest) {
      vitestStep(
        R,
        ctx,
        tmp,
        'vitest test/signals/state-store.test.ts',
        ['test/signals/state-store.test.ts'],
        {
          files: { 'test/signals/state-store.test.ts': { min: 3, controls: 0 } },
          titles: [{ file: 'test/signals/state-store.test.ts', includes: '0600' }],
        },
      );
    }
  } finally {
    rmTmp(tmp);
    if (probeBase) fs.rmSync(probeBase, { recursive: true, force: true });
  }
  return R.exit();
}

await runMain(import.meta.url, 'A10', () => a10(process.argv.slice(2)));

// A10 隐私卫生:.state/ 0700/0600、git 不含 .state / 会话原文、reader-samples 只含哈希与行数、全量脱敏扫描零命中。
import * as crypto from 'node:crypto';
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
  // 以下均是公开规范 / 公开基础设施的域名,出现在 provenance 校验代码、文档与测试里,不是个人数据面。
  // slsa.dev:SLSA provenance predicate 类型 URI(https://slsa.dev/provenance/v1)。
  'slsa.dev',
  // in-toto.io:in-toto Statement 类型 URI(https://in-toto.io/Statement/v1)。
  'in-toto.io',
  // GitHub Actions OIDC 签发者(Fulcio 证书里的 issuer / SAN 校验值,公开)。
  'token.actions.githubusercontent.com',
  // Sigstore 公共基础设施(TUF 根 tuf-repo-cdn.sigstore.dev、Fulcio、Rekor、CT 日志、时间戳),后缀匹配含子域。
  'sigstore.dev',
  // 公开 npm 镜像(用户可配的 registry 示例与拒绝路径测试)。
  'registry.npmmirror.com',
  // Google OIDC 签发者(仅作为「issuer 不是 GitHub」的反例出现在 provenance 测试里)。
  'accounts.google.com',
];

/**
 * 精确钉死的公开信任材料(路径 -> 内容 sha256)。只有这 5 个文件,不用通配、不用目录级规则。
 *
 * 为什么:这些是从真实 Sigstore / npm 公共基础设施拷来的公开信任材料,签名校验测试要用它们对着真实信任根验签;
 * 里面的公钥、证书、哈希、签名不是秘密,但会被熵扫描(high_entropy / base64 解码后再扫)判为高熵。
 * 无法由测试用测试密钥生成同构材料(那等于自建一整套 Sigstore,且不再测真实验签路径),也不能靠拆串绕过扫描。
 * 来源:
 *   - att-rc0.json:npm registry 上 @chovizzz/agent-kit@0.1.0-rc.0 的真实 attestations 响应(SLSA provenance + publish attestation bundle)
 *   - tuf-cache/tuf-repo-cdn.sigstore.dev/{root,targets}.json、targets/trusted_root.json:Sigstore 公共 TUF 仓库的真实元数据 / 信任根
 *   - tuf-cache/.../targets/registry.npmjs.org%2Fkeys.json:npm registry 公钥(Sigstore TUF 目标文件)
 * 审阅:2026-10-22,由本仓库验收流程审阅(内容只有公钥 / 证书 / 哈希 / 签名 / 公开 URL,无个人数据);用户 2026-10-22 拍板采用「路径 + sha256 精确钉死」。
 *
 * 规则边界:
 *   - 只在「路径与 sha256 都匹配」时,忽略该文件的 high_entropy 与 decode_base64* 命中;其他规则(邮箱、密钥形态、IPv4、非白名单 URL 等)仍照常命中。
 *   - 文件有任何字节变化 => A10 失败(不是回退到普通扫描后碰巧通过);清单里的文件缺失 => A10 失败;
 *     目录下清单外的新文件照常整文件扫描。改动这些 fixture 必须同时更新这里的 sha256,并重新审阅。
 */
export const PINNED_PUBLIC_TRUST_MATERIAL = {
  'test/update/fixtures/att-rc0.json':
    '0eca4329085b6f7f649810042fd64ae7670345a30f000743c6efbfe0d6b894c5',
  'test/update/fixtures/tuf-cache/tuf-repo-cdn.sigstore.dev/root.json':
    '73747011d0857ada15479a16c4cae0f3ed03aac698b523b97e1de314ac9d9ca8',
  'test/update/fixtures/tuf-cache/tuf-repo-cdn.sigstore.dev/targets.json':
    '6a697f7f8908c8ab26c11786ecb490b54acec97fa8c802e399f065f8a0cc1acd',
  'test/update/fixtures/tuf-cache/tuf-repo-cdn.sigstore.dev/targets/registry.npmjs.org%2Fkeys.json':
    '160677eb6e1c7083c89b166b20f8fe4e837fb71181506aff1991b80b89184f7d',
  'test/update/fixtures/tuf-cache/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json':
    '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66',
};

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// 只认最终类别:high_entropy(含 base64 解码链上的 high_entropy);解码后的 url 仅限证书 SAN 里的公开工作流 URL
// (att-rc0.json 的 Fulcio 证书,内容已被 sha256 钉死)。解码后的邮箱 / 密钥形态等其他类别不放过。
const isEntropyRule = (r) => /^(decode_base64>)*high_entropy$/.test(r) || r === 'decode_base64>url';

/**
 * 核对钉死清单。返回 { problems, ok }:ok 是「路径与 sha256 都匹配」的文件集合(只有它们能忽略熵命中)。
 * 清单里的路径不在文件清单里 / 读不到 => problem;sha256 不符 => problem(且不进 ok)。
 */
export function checkPins(root, files, pins) {
  const problems = [];
  const ok = new Set();
  const present = new Set(files);
  for (const [rel, want] of Object.entries(pins)) {
    if (!present.has(rel)) {
      problems.push(`${rel}: 钉死清单里的文件不存在`);
      continue;
    }
    let got;
    try {
      got = sha256Hex(fs.readFileSync(path.join(root, rel)));
    } catch (e) {
      problems.push(`${rel}: 读取失败 ${String(e.message).slice(0, 60)}`);
      continue;
    }
    if (got !== want) problems.push(`${rel}: sha256 与钉死值不符(文件被改动,或清单未更新)`);
    else ok.add(rel);
  }
  return { problems, ok };
}

/** 去掉钉死文件上的熵类命中;其余命中保留。 */
export function dropPinnedEntropyHits(hits) {
  return hits.filter((h) => !isEntropyRule(h));
}

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
  const { flags } = parseCommon(argv, {
    bool: ['no-vitest', 'no-scan'],
    multi: ['allow-host'],
    value: ['pins'],
  });
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
            // 钉死的公开信任材料:--pins <json> 可替换清单(none = 空,测试 / 沙箱仓库用);默认用上面的真实清单
            const pins =
              flags.pins === undefined
                ? PINNED_PUBLIC_TRUST_MATERIAL
                : flags.pins === 'none'
                  ? {}
                  : JSON.parse(fs.readFileSync(flags.pins, 'utf8'));
            const pinCheck = checkPins(ctx.root, files, pins);
            if (pinCheck.problems.length)
              R.fail(`公开信任材料钉死校验失败:${pinCheck.problems.join(' | ')}`);
            for (const f of files) {
              // 已 git 跟踪但工作树里被删掉的文件:钉死清单会在上面报「读取失败」,这里不让它崩掉整个扫描
              if (!fs.existsSync(path.join(ctx.root, f))) continue;
              const buf = fs.readFileSync(path.join(ctx.root, f));
              if (!isText(buf)) continue;
              scanned++;
              const res = scanner.scanText(buf.toString('utf8'));
              if (pinCheck.ok.has(f)) res.hits = dropPinnedEntropyHits(res.hits);
              if (res.hits.length) bad.push(`${f}(${[...new Set(res.hits)].join(',')})`);
              else if (res.failure) bad.push(`${f}(扫描失败:${res.failure})`);
            }
            if (bad.length)
              R.fail(`脱敏扫描命中 ${bad.length} 个文件:${bad.slice(0, 40).join(' | ')}`);
            else
              R.pass(
                `脱敏扫描 ${scanned} 个文本文件零命中(无豁免,仅 ${pinCheck.ok.size} 个路径+sha256 钉死的公开信任材料忽略熵命中;植入正向对照已检出)`,
              );
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

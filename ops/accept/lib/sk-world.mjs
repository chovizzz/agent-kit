// A25 / A27 共用:sync / update 的验收世界。全部合成数据,写盘只落在 KIT_TMP 之内的假 HOME / 假包根 / 假 registry。
// 与 test/sync/world.ts、test/update/install-world.ts 同口径,但直接用 tsc 产物(distSrc)里的真模块进程内运行命令层:
// 真实 CLI 入口 main(argv) 不注入 env,拿不到 KIT_PAYLOAD_DIR / 验签器注入点,所以 payload 夹具与假 registry 只能这样接线。
// 零网络:进程内加载 ops/guards/no-net.cjs 垫片(并用一次必被拦的 fetch 证明垫片生效)。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { byteCmp, mkTmp, sha256 } from './common.mjs';
import { importDist } from './accept-p1.mjs';
export { realHomeGuard } from './real-home-guard.mjs';

export const SAFE_ENV_PATH = '/usr/bin:/bin';
export const STATE_REL = '.local/state/agent-kit';

// ---------------------------------------------------------------- 加载产品模块

export async function loadMods(ctx) {
  return {
    payload: await importDist(ctx, 'build/payload.js'),
    contracts: await importDist(ctx, 'contracts/payload.js'),
    block: await importDist(ctx, 'render/managed-block.js'),
    canon: await importDist(ctx, 'io/canonical-json.js'),
    paths: await importDist(ctx, 'io/paths.js'),
    sync: await importDist(ctx, 'commands/sync.js'),
    update: await importDist(ctx, 'commands/update.js'),
  };
}

// ---------------------------------------------------------------- 零网络垫片

/**
 * 进程内加载 no-net 垫片。返回 { log, blockedCount() }。
 * 正向对照:装好后立刻发一次 fetch,必须被拦且留痕;随后清空日志,之后日志里出现任何一行都算"碰了网络"。
 */
export async function installNoNet(ctx, tmp) {
  const log = path.join(tmp, 'no-net.log');
  process.env.KIT_NO_NET_LOG = log;
  const req = createRequire(import.meta.url);
  req(path.join(ctx.root, 'ops', 'guards', 'no-net.cjs'));
  let controlBlocked = false;
  try {
    await fetch('http://127.0.0.1:9/');
  } catch (e) {
    controlBlocked =
      e?.code === 'ENO_NET' || /no-net/.test(String(e?.cause?.message ?? e?.message));
  }
  const controlLogged = fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim() !== '';
  fs.rmSync(log, { force: true });
  return {
    log,
    controlOk: controlBlocked && controlLogged,
    blocked: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l.trim() !== '')
        : [],
  };
}

// ---------------------------------------------------------------- 世界(目录)

/**
 * 在 ctx.tmpBase 下建一个世界。form='link':KIT_TMP 与所有路径都用「符号链接形式」的写法(link -> 真实目录),
 * 覆盖 macOS /var -> /private/var 这类符号链接下产品的路径比较。
 * 返回 { real, kit(KIT_TMP 的写法), home, pkg, reg, cleanup() }。
 */
export function makeWorldDirs(ctx, label, form) {
  const real = mkTmp(ctx, label);
  let kit = real;
  let link = null;
  if (form === 'link') {
    link = `${real}-lnk`;
    fs.symlinkSync(real, link);
    kit = link;
  }
  const home = path.join(kit, 'home');
  const pkg = path.join(kit, 'pkg');
  const reg = path.join(kit, 'reg');
  for (const d of [home, pkg]) fs.mkdirSync(d, { recursive: true });
  return {
    real,
    kit,
    home,
    pkg,
    reg,
    form,
    cleanup() {
      if (link) fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- 树快照与比较

const isStateRel = (rel) =>
  rel === '.local' ||
  rel === '.local/state' ||
  rel === STATE_REL ||
  rel.startsWith(`${STATE_REL}/`);

/**
 * 快照:files(相对路径 -> "权限位 sha256" | "link -> 目标")、dirs、mtimes(文件与目录)。
 * skipState:忽略 .local 与 .local/state 与 .local/state/agent-kit/**(契约 §19.2 的判据)。
 */
export function snapTree(root, { skipState = false } = {}) {
  const t = { files: new Map(), dirs: new Set(), mtimes: new Map() };
  const walk = (rel) => {
    const abs = rel === '' ? root : path.join(root, rel);
    for (const name of fs.readdirSync(abs).sort(byteCmp)) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (skipState && isStateRel(r)) continue;
      const p = path.join(root, r);
      const st = fs.lstatSync(p);
      t.mtimes.set(r, st.mtimeMs);
      if (st.isSymbolicLink()) t.files.set(r, `link -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        t.dirs.add(r);
        walk(r);
      } else t.files.set(r, `${(st.mode & 0o777).toString(8)} ${sha256(fs.readFileSync(p))}`);
    }
  };
  walk('');
  return t;
}

/**
 * 契约 §19.2 的往返判据:文件集合(路径 + 权限位 + 内容 sha256)逐字节一致;原有目录不得消失;新增目录子树里不得有任何文件。
 * 返回问题列表(空 = 一致)。
 */
export function compareRoundtrip(before, after) {
  const problems = [];
  for (const [k, v] of before.files) {
    if (!after.files.has(k)) problems.push(`缺失 ${k}`);
    else if (after.files.get(k) !== v) problems.push(`改变 ${k}`);
  }
  for (const k of after.files.keys()) if (!before.files.has(k)) problems.push(`多出 ${k}`);
  for (const d of before.dirs) if (!after.dirs.has(d)) problems.push(`原有目录消失 ${d}/`);
  for (const d of after.dirs) {
    if (before.dirs.has(d)) continue;
    const leftover = [...after.files.keys()].filter((f) => f.startsWith(`${d}/`));
    if (leftover.length > 0) problems.push(`新增目录 ${d}/ 不为空(含 ${leftover.length} 个文件)`);
  }
  return problems;
}

/** 完整快照(含状态目录)是否逐项相同,且文件/目录 mtime 无变化。返回问题列表。 */
export function compareExact(a, b) {
  const problems = [];
  const keys = new Set([...a.mtimes.keys(), ...b.mtimes.keys()]);
  for (const k of [...keys].sort(byteCmp)) {
    if (!a.mtimes.has(k)) problems.push(`新增 ${k}`);
    else if (!b.mtimes.has(k)) problems.push(`消失 ${k}`);
    else {
      if (a.mtimes.get(k) !== b.mtimes.get(k)) problems.push(`mtime 变化 ${k}`);
      if (a.files.get(k) !== b.files.get(k)) problems.push(`内容或权限变化 ${k}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- sync 世界

export const BLOCK_ID = 'agent-kit-rules';
export const SKILL = '.claude/skills/commit-checklist/SKILL.md';
export const SHARED = '.agents/skills/commit-checklist/SKILL.md';
export const RULES = '.claude/rules/agent-kit/org.md';
export const CODEX_MD = '.codex/AGENTS.md';
export const PI_MD = '.pi/agent/AGENTS.md';
const CANARY = 'kit-canary-A25-PAYLOAD';

export function syncFixture() {
  const skill = `---\nname: commit-checklist\ndescription: 提交前清单\n---\n\n提交前检查清单 ${CANARY}\n`;
  const rules = `# 团队规则\n\n先写测试。${CANARY}\n`;
  const body = `规则块\n- 先读后改。${CANARY}\n`;
  return [
    { agent: 'claude', path: SKILL, content: skill, kind: 'skill' },
    { agent: 'claude', path: RULES, content: rules, kind: 'rules' },
    { agent: 'codex', path: SHARED, content: skill, kind: 'skill' },
    { agent: 'codex', path: CODEX_MD, content: body, block: BLOCK_ID, kind: 'rules' },
    { agent: 'pi', path: SHARED, content: skill, kind: 'skill' },
    { agent: 'pi', path: PI_MD, content: body, block: BLOCK_ID, kind: 'rules' },
  ];
}

/** 用户原有文件(都以单个 \n 结尾:契约保证块的卸载对这类文件逐字节还原)。 */
export const SEEDED_HOME = [
  { rel: '.codex/AGENTS.md', text: '# 我的 codex 笔记\n- 保持简短\n', mode: 0o600 },
  { rel: '.pi/agent/AGENTS.md', text: '# 我的 pi 笔记\n', mode: 0o644 },
  { rel: '.claude/settings.json', text: '{"theme":"dark"}\n', mode: 0o600 },
  { rel: '.claude/skills/mine/SKILL.md', text: '---\nname: mine\n---\n我的技能\n', mode: 0o644 },
];

export function seedHome(home, seeds = SEEDED_HOME) {
  for (const s of seeds) {
    const abs = path.join(home, s.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, s.text, { mode: s.mode });
    fs.chmodSync(abs, s.mode);
  }
}

/** 写 payload 夹具(payload/manifest.json + payload/files/** + integrity.json),口径同 test/sync/world.ts。 */
export function writePayloadFixture(mods, pkgRoot, files, kitVersion = '0.2.0') {
  const sorted = [...files].sort((a, b) => {
    const ka = `${a.agent}/home/${a.path}`;
    const kb = `${b.agent}/home/${b.path}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const tree = new Map();
  const entries = sorted.map((f) => {
    const text =
      f.block !== undefined ? mods.block.renderManagedBlock(f.block, f.content) : f.content;
    const mode = f.block !== undefined ? 'managed-block' : 'owned';
    const payloadPath = `files/${f.agent}/home/${f.path}`;
    tree.set(`payload/${payloadPath}`, text);
    return {
      agent: f.agent,
      target: 'home',
      path: f.path,
      mode,
      ...(f.block !== undefined ? { block_id: f.block } : {}),
      kind: f.kind ?? 'skill',
      confidence: 'documented',
      sha256: mods.payload.payloadFileSha(mode, text, f.block),
      bytes: Buffer.byteLength(text),
      payload_path: payloadPath,
      atoms: [{ id: 'a-one', layer: 'org', strength: 'should' }],
    };
  });
  const manifest = mods.contracts.PayloadManifestSchema.parse({
    schema_version: 1,
    kit_version: kitVersion,
    channel: 'stable',
    files: entries,
    migrations: [],
    skippedLayers: [{ layer: 'personal', reason: 'v1' }],
  });
  tree.set('payload/manifest.json', mods.canon.canonicalJson(manifest));
  fs.rmSync(path.join(pkgRoot, 'payload'), { recursive: true, force: true });
  fs.rmSync(path.join(pkgRoot, 'integrity.json'), { force: true });
  for (const [rel, text] of tree) {
    const abs = path.join(pkgRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const integ = mods.payload.buildIntegrity(
    kitVersion,
    [...tree].map(([p, t]) => ({ path: p, content: Buffer.from(t) })),
  );
  fs.writeFileSync(path.join(pkgRoot, 'integrity.json'), integ.text);
  return manifest;
}

function makeIo(mods, ctx, kit) {
  return mods.paths.createIoContext({ cwd: ctx.root, env: { KIT_TMP: kit, PATH: SAFE_ENV_PATH } });
}

/** 进程内跑 sync 命令层(与 test/sync/world.ts 的 run 同形)。 */
export async function runSync(mods, ctx, dirs, args, o = {}) {
  const out = [];
  const err = [];
  const env = { KIT_TMP: dirs.kit, PATH: SAFE_ENV_PATH, KIT_PAYLOAD_DIR: dirs.pkg, ...o.env };
  const cmd = {
    argv: [...(o.noHome === true ? [] : ['--home', dirs.home]), ...args],
    io: makeIo(mods, ctx, dirs.kit),
    overlayPath: undefined,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
  };
  const code = await mods.sync.createSyncCommand().run(cmd);
  return { code, out: out.join(''), err: err.join('') };
}

export const jsonOf = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- update 世界(tar / registry / 命令)

export const PKG_NAME = '@chovizzz/agent-kit';
export const NOW_HTTP = 'Wed, 14 Oct 2026 12:00:00 GMT';
export const NOW_MS = Date.parse('2026-10-14T12:00:00Z');
export const OLD_ISO = '2026-10-10T12:00:00.000Z';
const OLD_SECS = Math.floor(Date.parse(OLD_ISO) / 1000);
const sha512 = (b) => createHash('sha512').update(b).digest('hex');

const oct = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

function tarHeader(e, size) {
  const h = Buffer.alloc(512);
  Buffer.from(e.name).copy(h, 0);
  h.write(oct(e.mode ?? 0o644, 8), 100, 'latin1');
  h.write(oct(0, 8), 108, 'latin1');
  h.write(oct(0, 8), 116, 'latin1');
  h.write(oct(size, 12), 124, 'latin1');
  h.write(oct(0, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname) h.write(e.linkname, 157, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function tarEntry(e) {
  const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(e, data.length), data, pad]);
}

/**
 * 造一个合法的 npm 包 tarball(package/ 前缀 + integrity.json)。
 * o.integrity(base) 可改写 integrity 对象(返回 undefined = 不放 integrity.json)。
 */
export function buildPkg(mods, version, o = {}) {
  const files = [
    {
      path: 'package.json',
      data: JSON.stringify({ name: PKG_NAME, version, bin: { 'agent-kit': 'dist/cli.js' } }),
    },
    {
      path: 'dist/cli.js',
      data: `#!/usr/bin/env node\nconsole.log('cli ${version}');\n`,
      mode: 0o755,
    },
    { path: 'dist/main.js', data: `export const v = '${version}';\n` },
    { path: 'README.md', data: `# agent-kit ${version}\n` },
    { path: 'LICENSE', data: 'UNLICENSED\n' },
  ];
  const listed = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => {
      const b = Buffer.from(f.data);
      return { path: f.path, sha256: sha256(b), bytes: b.byteLength };
    });
  const base = { schema_version: 1, kit_version: version, algorithm: 'sha256', files: listed };
  const integrity = o.integrity === undefined ? base : o.integrity(base);
  const integrityBytes = Buffer.from(
    integrity === undefined ? '' : mods.canon.canonicalJson(integrity),
  );
  const entries = [{ name: 'package/', type: '5', mode: 0o755 }];
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort()) entries.push({ name: `package/${d}/`, type: '5', mode: 0o755 });
  for (const f of files)
    entries.push({ name: `package/${f.path}`, data: f.data, mode: f.mode ?? 0o644 });
  if (integrity !== undefined)
    entries.push({ name: 'package/integrity.json', data: integrityBytes });
  const tgz = gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
  return { version, tgz, sha512: sha512(tgz), anchor: sha256(integrityBytes) };
}

function makeAtt(version, sha512Hex) {
  const st = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/%40chovizzz/agent-kit@${version}`, digest: { sha512: sha512Hex } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/chovizzz/agent-kit',
            path: '.github/workflows/release.yml',
            ref: `refs/tags/v${version}`,
          },
        },
      },
    },
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const slsa = {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        tlogEntries: [
          { integratedTime: String(OLD_SECS), inclusionPromise: { signedEntryTimestamp: 'AAAA' } },
        ],
        timestampVerificationData: {},
      },
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: b64(st),
        signatures: [{ sig: 'AAAA' }],
      },
    },
  };
  const publish = {
    predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: { tlogEntries: [] },
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: b64({
          _type: 'https://in-toto.io/Statement/v0.1',
          subject: st.subject,
          predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
          predicate: {},
        }),
        signatures: [{ sig: 'AAAA' }],
      },
    },
  };
  return { attestations: [publish, slsa] };
}

/** 假验证器:签名者身份取自 statement 里的 workflow.ref(= 视为签名有效)。真验签由 provenance 自己的测试覆盖,这里不联网。 */
export const okVerifier = async (bundle) => {
  const st = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const ref = st.predicate.buildDefinition.externalParameters.workflow.ref;
  return {
    subjectAlternativeName: `https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@${ref}`,
    issuer: 'https://token.actions.githubusercontent.com',
  };
};

/**
 * 写假 registry 目录(reg):packument.json / packument.date / tarballs/<v>.tgz / attestations/<v>.json。
 * versions:[{ pkg, integrity?(覆盖 dist.integrity) }];distTags:{latest:'x'}。
 */
export function writeRegistry(reg, versions, distTags) {
  fs.rmSync(reg, { recursive: true, force: true });
  fs.mkdirSync(path.join(reg, 'tarballs'), { recursive: true });
  fs.mkdirSync(path.join(reg, 'attestations'), { recursive: true });
  const vs = {};
  const time = {};
  for (const v of versions) {
    vs[v.pkg.version] = {
      name: PKG_NAME,
      version: v.pkg.version,
      dist: {
        tarball: `tarballs/${v.pkg.version}.tgz`,
        integrity: v.integrity ?? `sha512-${Buffer.from(v.pkg.sha512, 'hex').toString('base64')}`,
      },
    };
    time[v.pkg.version] = OLD_ISO;
    fs.writeFileSync(path.join(reg, 'tarballs', `${v.pkg.version}.tgz`), v.pkg.tgz);
    fs.writeFileSync(
      path.join(reg, 'attestations', `${v.pkg.version}.json`),
      JSON.stringify(makeAtt(v.pkg.version, v.pkg.sha512)),
    );
  }
  fs.writeFileSync(
    path.join(reg, 'packument.json'),
    JSON.stringify({ name: PKG_NAME, 'dist-tags': distTags, versions: vs, time }),
  );
  fs.writeFileSync(path.join(reg, 'packument.date'), NOW_HTTP);
}

/** 进程内跑 update 命令层(固定时钟 + 假验证器;可统计验签次数)。 */
export async function runUpdate(mods, ctx, dirs, args, o = {}) {
  const out = [];
  const err = [];
  let verifyCalls = 0;
  const env = {
    KIT_TMP: dirs.kit,
    PATH: SAFE_ENV_PATH,
    KIT_UPDATE_REGISTRY: `file://${dirs.reg}`,
    ...o.env,
  };
  const cmd = {
    argv: [...(o.noHome === true ? [] : ['--home', dirs.home]), ...args],
    io: makeIo(mods, ctx, dirs.kit),
    overlayPath: undefined,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
  };
  const deps = {
    now: () => new Date(NOW_MS),
    verifier: async (b, x) => {
      verifyCalls += 1;
      return okVerifier(b, x);
    },
  };
  const code = await mods.update.createUpdateCommand(deps).run(cmd);
  return { code, out: out.join(''), err: err.join(''), verifyCalls };
}

export const share = (dirs) => path.join(dirs.home, '.local', 'share', 'agent-kit');
export const updateState = (dirs) =>
  JSON.parse(
    fs.readFileSync(
      path.join(dirs.home, '.local', 'state', 'agent-kit', 'update', 'state.json'),
      'utf8',
    ),
  );
export const currentVersion = (dirs) => {
  const cur = path.join(share(dirs), 'current');
  return fs.lstatSync(cur, { throwIfNoEntry: false }) ? path.basename(fs.realpathSync(cur)) : null;
};

// 受管路径快照 / 比对(A5 副判据)。只读:lstat / readdir / readlink / 读文件算 sha256;从不写 HOME。
// 报告里只放 `~/…` 形式的路径与哈希,不放文件内容。
//
// 快照记录(按 plan B17 要点):
//   - 字面文件:存在与否 + sha256;符号链接记录 readlink 目标,并(目标在 HOME 内时)跟随到目标:
//     文件记 size/sha256,目录记整棵树摘要;目标在 HOME 之外时不读内容,只记目标 lstat 元数据并登记
//     outside_links(=> 退出 5 待人工归因)。通过链接写入因此检测得到(B20 ZW-3)。
//   - 目录条目(以 / 结尾):顶层条目名列表 + 每个条目的 sha256(文件)/ readlink(符号链接)/
//     (子目录)SKILL.md 与其顶层普通文件的 sha256 + 整棵子树的「路径 + 类型 + 大小 + 内容 sha256 + ctime」摘要
//     (深层文件的同长度改写、写后还原都会改变摘要;B20 ZW-2)。
//   - glob:展开结果本身(含空展开)参与比对。
//   - volatile:只剔除(路径或其祖先命中)。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compileEntry,
  compileVolatile,
  expandGlob,
  findListConflicts,
  parseList,
  toAbsolute,
  toTilde,
} from './lists.mjs';

export const HOME_WATCH = [
  '~',
  '~/.config',
  '~/.cache',
  '~/.npm',
  '~/.local',
  '~/.local/share',
  '~/.local/state',
];
const MAX_HASH_BYTES = 64 * 1024 * 1024;

export function resolveHome(explicit) {
  if (explicit) return path.resolve(explicit);
  const o = process.env.KIT_REAL_HOME_OVERRIDE;
  if (o) return path.resolve(o);
  if (process.env.KIT_OPS_NO_REAL_HOME === '1') {
    throw new Error(
      'KIT_OPS_NO_REAL_HOME=1:未指定 --home / KIT_REAL_HOME_OVERRIDE,拒绝读取真实 HOME',
    );
  }
  return os.homedir();
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function sha256File(p, size) {
  if (size > MAX_HASH_BYTES) return `oversize:${size}`;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (e) {
    return `unreadable:${e.code ?? 'ERR'}`;
  }
}

function readlinkOrNull(p, ctx) {
  try {
    // 指向 HOME 内的绝对目标折成 ~/…,报告里不出现真实 HOME 路径
    const t = fs.readlinkSync(p);
    return ctx ? ctx.tilde(t) : t;
  } catch {
    return null;
  }
}

function readdirNames(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
}

const TREE_MAX_FILES = 50000;
/** 整棵树里读内容哈希的总字节上限;超过后只记 size+ctime 并标记截断(=> fail-closed,不是静默)。 */
const TREE_MAX_HASH_TOTAL = 1024 * 1024 * 1024;

/** HOME 内但含凭据的位置:不跟随读内容(报告里会有内容哈希),按「HOME 之外」处理——只记元数据。 */
const SENSITIVE_HOME_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.azure',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.config/gcloud',
  '.config/gh',
  '.config/lark-cli',
  '.git-credentials',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bash_profile',
  '.bashrc',
  '.codex/auth.json',
  '.pi/agent/auth.json',
  'Library',
];

/** 路径是否落在凭据位置(按 ctx.home 与其 realpath 两种前缀判断)。 */
function isSensitivePath(p, ctx) {
  return SENSITIVE_HOME_DIRS.some(
    (d) => isUnder(p, path.join(ctx.home, d)) || isUnder(p, path.join(ctx.realHome, d)),
  );
}

/** 能跟随读内容的目标:在 HOME 内、不是 HOME 本身、不是凭据位置、也不是任何凭据位置的祖先。 */
function inFollowScope(real, realHome) {
  if (!isUnder(real, realHome) || real === realHome) return false;
  return !SENSITIVE_HOME_DIRS.some((d) => {
    const sd = path.join(realHome, d);
    return isUnder(real, sd) || isUnder(sd, real);
  });
}

/** volatile 判定:被跟随的链接目标按「链接路径」判(而不是 realpath),否则可以对目标真实路径写 volatile 行挖空监视。 */
function isVol(ctx, p) {
  for (const a of ctx.aliases) {
    if (isUnder(p, a.real)) return ctx.vol.isVolatile(a.link + p.slice(a.real.length));
  }
  return ctx.vol.isVolatile(p);
}

/** HOME 之外的目录:不读内容,只记「路径 + 类型 + 大小 + ctime」(原地改写文件会改文件 ctime)。 */
function metaDigest(root) {
  const lines = [];
  let truncated = false;
  const walk = (dir, rel) => {
    if (lines.length > TREE_MAX_FILES) {
      truncated = true;
      return;
    }
    const ents = readdirNames(dir);
    if (ents === null) return;
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const lst = lstatOrNull(p);
      if (!lst) continue;
      if (lst.isDirectory()) {
        lines.push(`${r}\tD`);
        walk(p, r);
      } else
        lines.push(
          `${r}\t${lst.isSymbolicLink() ? 'L' : 'F'}\t${lst.size}\t${Math.trunc(lst.ctimeMs)}`,
        );
    }
  };
  walk(root, '');
  if (truncated) lines.push('TRUNCATED');
  return { digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), truncated };
}

function isUnder(p, root) {
  return p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 符号链接目标摘要(只在 HOME 内跟随)。返回 { rec, ctime } :
 *   rec  - 并入快照记录的 target 字段(文件:size+sha;目录:树摘要;HOME 之外:仅元数据);
 *   ctime - 目标(及目标树)的最大 ctime,并入 meta 供归因/「被碰过」判断。
 * nested=true(树内部的链接)时不再递归目录,只记目录的存在。
 */
function linkTarget(abs, ctx, nested) {
  const real = realpathOrNull(abs);
  if (real === null) return { rec: { dangling: true }, ctime: 0, contentCtime: 0 };
  let tst;
  try {
    tst = fs.statSync(real);
  } catch {
    return { rec: { dangling: true }, ctime: 0, contentCtime: 0 };
  }
  if (!inFollowScope(real, ctx.realHome)) {
    // 不读 HOME 之外(或凭据位置)的内容;只记元数据(写入会改 ctime/size => 快照有差异),并登记为盲区链接
    ctx.outsideLinks.add(ctx.tilde(abs));
    let meta = {};
    if (tst.isDirectory() && !nested) {
      const md = metaDigest(real);
      if (md.truncated) ctx.truncated = true;
      meta = { tree: md.digest };
    }
    return {
      rec: {
        outside: true,
        t: tst.isDirectory() ? 'dir' : 'file',
        size: tst.size,
        ctime_ms: Math.trunc(tst.ctimeMs),
        ...meta,
      },
      ctime: Math.trunc(tst.ctimeMs),
      contentCtime: Math.trunc(tst.ctimeMs),
    };
  }
  if (tst.isDirectory()) {
    if (nested) return { rec: { t: 'dir' }, ctime: Math.trunc(tst.ctimeMs), contentCtime: 0 };
    ctx.aliases.push({ real, link: abs });
    const tree = treeDigest(real, ctx.vol, ctx);
    ctx.aliases.pop();
    if (tree.truncated) ctx.truncated = true;
    return {
      rec: { t: 'dir', tree: tree.digest },
      ctime: Math.max(Math.trunc(tst.ctimeMs), tree.maxCtime),
      contentCtime: tree.contentCtime,
    };
  }
  if (tst.isFile()) {
    return {
      rec: { t: 'file', size: tst.size, sha: sha256File(real, tst.size) },
      ctime: Math.trunc(tst.ctimeMs),
      contentCtime: Math.trunc(tst.ctimeMs),
    };
  }
  return {
    rec: { t: 'other' },
    ctime: Math.trunc(tst.ctimeMs),
    contentCtime: Math.trunc(tst.ctimeMs),
  };
}

/**
 * 目录整棵树的摘要:每个文件「相对路径 + 大小 + 内容 sha256 + ctime」(不跟随目录符号链接;volatile 剔除)。
 * 抓得到嵌套文件的增删、大小变化、同长度改写、写后还原(ctime 变)。
 * 树内部的符号链接只记 readlink 与文件目标的哈希(目录目标不再递归),HOME 之外的目标不读内容。
 */
function treeDigest(root, vol, ctx) {
  const lines = [];
  let maxCtime = 0;
  let contentCtime = 0; // 只算文件/链接,不算目录:目录 ctime 会被 volatile 子项的增删抬高
  let truncated = false;
  const walk = (dir, rel) => {
    if (lines.length > TREE_MAX_FILES) {
      truncated = true;
      return;
    }
    const ents = readdirNames(dir);
    if (ents === null) {
      // 遍历中途消失的目录(竞态)不算读不了;真读不了的不再静默:摘要里留一行,且按截断处理(fail-closed)
      if (lstatOrNull(dir) === null) return;
      lines.push(`${rel || '.'}\tUNREADABLE`);
      truncated = true;
      return;
    }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, e.name);
      if (isVol(ctx, p)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const lst = lstatOrNull(p);
      if (lst) maxCtime = Math.max(maxCtime, Math.trunc(lst.ctimeMs));
      if (e.isSymbolicLink()) {
        const t = linkTarget(p, ctx, true);
        maxCtime = Math.max(maxCtime, t.ctime);
        contentCtime = Math.max(contentCtime, t.contentCtime, lst ? Math.trunc(lst.ctimeMs) : 0);
        lines.push(`${r}\tL\t${readlinkOrNull(p) ?? ''}\t${JSON.stringify(t.rec)}`);
      } else if (e.isDirectory()) {
        lines.push(`${r}\tD`);
        walk(p, r);
      } else {
        let sha = '-';
        if (lst) contentCtime = Math.max(contentCtime, Math.trunc(lst.ctimeMs));
        if (lst && lst.isFile() && !isSensitivePath(p, ctx)) {
          if (lst.size > MAX_HASH_BYTES) sha = `oversize:${lst.size}`;
          else if (ctx.hashedBytes + lst.size > TREE_MAX_HASH_TOTAL) truncated = true;
          else {
            sha = sha256File(p, lst.size);
            ctx.hashedBytes += lst.size;
          }
        }
        // ctime 不进摘要(只读之外的无关写入如 git index 刷新会造成大面积误报);同长度改写由 sha 抓,
        // 窗口内的「碰过/写后还原」由 content_ctime_ms 的 touched 判据抓
        lines.push(`${r}\tF\t${lst ? lst.size : -1}\t${sha}`);
      }
    }
  };
  walk(root, '');
  if (truncated) lines.push('TRUNCATED');
  return {
    digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
    maxCtime,
    contentCtime,
    truncated,
  };
}

/** 单个路径(不递归)的记录。dirDepth: 'shallow' = 目录只记名字表与 SKILL.md/顶层文件哈希。 */
function describe(abs, ctx) {
  const st = lstatOrNull(abs);
  if (!st) {
    noteParentDir(abs, ctx);
    return { t: 'absent' };
  }
  ctx.meta[ctx.tilde(abs)] = { ctime_ms: Math.trunc(st.ctimeMs), mtime_ms: Math.trunc(st.mtimeMs) };
  if (st.isSymbolicLink()) {
    const t = linkTarget(abs, ctx, false);
    const m = ctx.meta[ctx.tilde(abs)];
    m.content_ctime_ms = Math.max(m.ctime_ms, t.contentCtime);
    m.ctime_ms = Math.max(m.ctime_ms, t.ctime);
    return { t: 'symlink', link: readlinkOrNull(abs, ctx), target: t.rec };
  }
  if (st.isFile()) return { t: 'file', size: st.size, sha: sha256File(abs, st.size) };
  if (st.isDirectory()) {
    const ents = readdirNames(abs);
    if (ents === null) return { t: 'dir', unreadable: true };
    noteDir(abs, st, ctx);
    const names = ents.map((e) => e.name).filter((n) => !isVol(ctx, path.join(abs, n)));
    names.sort();
    const rec = { t: 'dir', names };
    const files = {};
    for (const e of ents) {
      if (!e.isFile() || isVol(ctx, path.join(abs, e.name))) continue;
      const fst = lstatOrNull(path.join(abs, e.name));
      if (!fst) continue;
      files[e.name] = sha256File(path.join(abs, e.name), fst.size);
      ctx.meta[ctx.tilde(path.join(abs, e.name))] = {
        ctime_ms: Math.trunc(fst.ctimeMs),
        mtime_ms: Math.trunc(fst.mtimeMs),
      };
    }
    const tree = treeDigest(abs, ctx.vol, ctx);
    if (tree.truncated) ctx.truncated = true;
    rec.tree = tree.digest;
    if (Object.keys(files).length) rec.files = Object.fromEntries(Object.entries(files).sort());
    // 目录记录的 ctime 取「目录自身与其已哈希顶层文件」的最大值,归因时才不会漏掉只改文件内容的写入
    let c = Math.max(Math.trunc(st.ctimeMs), tree.maxCtime);
    for (const n of Object.keys(files))
      c = Math.max(c, ctx.meta[ctx.tilde(path.join(abs, n))]?.ctime_ms ?? 0);
    ctx.meta[ctx.tilde(abs)] = {
      ctime_ms: c,
      content_ctime_ms: tree.contentCtime,
      mtime_ms: Math.trunc(st.mtimeMs),
    };
    return rec;
  }
  return { t: 'other', mode: st.mode & 0o170000 };
}

function noteDir(abs, st, ctx) {
  ctx.dirs[ctx.tilde(abs)] = Math.trunc(st.ctimeMs);
}

function noteParentDir(abs, ctx) {
  let d = path.dirname(abs);
  for (let i = 0; i < 64; i++) {
    const st = lstatOrNull(d);
    if (st) {
      noteDir(d, st, ctx);
      return;
    }
    const n = path.dirname(d);
    if (n === d) return;
    d = n;
  }
}

function addPath(abs, rec, source, ctx) {
  const key = ctx.tilde(abs);
  if (ctx.vol.isVolatile(abs)) {
    ctx.volatileExcluded.add(key);
    return;
  }
  const prev = ctx.paths[key];
  if (prev === undefined) ctx.paths[key] = rec;
  (ctx.sources[key] ??= new Set()).add(source);
}

/** 目录条目:目录自身 + 每个顶层子条目一条记录。 */
function snapDir(abs, source, ctx) {
  const st = lstatOrNull(abs);
  if (!st) {
    addPath(abs, { t: 'absent' }, source, ctx);
    noteParentDir(abs, ctx);
    return;
  }
  const link = st.isSymbolicLink() ? readlinkOrNull(abs, ctx) : null;
  let real = abs;
  if (link !== null) {
    try {
      real = fs.realpathSync(abs);
    } catch {
      addPath(abs, { t: 'symlink', link, dangling: true }, source, ctx);
      return;
    }
    if (!inFollowScope(real, ctx.realHome)) {
      // 不跟随到 HOME 之外读内容:只记目标元数据(写入会改 ctime/size => 快照有差异),登记为盲区链接
      ctx.outsideLinks.add(ctx.tilde(abs));
      const ost = lstatOrNull(real);
      const md = ost && ost.isDirectory() ? metaDigest(real) : null;
      if (md?.truncated) ctx.truncated = true;
      addPath(
        abs,
        {
          t: 'symlink',
          link,
          outside: true,
          ...(ost ? { size: ost.size, ctime_ms: Math.trunc(ost.ctimeMs) } : {}),
          ...(md ? { tree: md.digest } : {}),
        },
        source,
        ctx,
      );
      return;
    }
  }
  const ents = readdirNames(real);
  if (ents === null) {
    addPath(abs, { t: link !== null ? 'symlink' : 'file', link, unreadable: true }, source, ctx);
    return;
  }
  const rst = lstatOrNull(real);
  if (rst) noteDir(abs, rst, ctx);
  const visible = ents.filter((e) => !ctx.vol.isVolatile(path.join(abs, e.name)));
  addPath(
    abs,
    { t: 'dir', ...(link !== null ? { link } : {}), names: visible.map((e) => e.name).sort() },
    source,
    ctx,
  );
  if (link !== null) ctx.aliases.push({ real, link: abs });
  for (const e of visible) {
    const child = path.join(abs, e.name);
    // 子路径记录:用 real 目录下的同名项读取(符号链接目录本身时通过 real 访问)
    const readFrom = link !== null ? path.join(real, e.name) : child;
    addPath(child, describeChild(readFrom, child, ctx), source, ctx);
  }
  if (link !== null) ctx.aliases.pop();
}

function describeChild(readFrom, keyPath, ctx) {
  const rec = describe(readFrom, ctx);
  if (readFrom !== keyPath) {
    const m = ctx.meta[ctx.tilde(readFrom)];
    if (m) {
      ctx.meta[ctx.tilde(keyPath)] = m;
      delete ctx.meta[ctx.tilde(readFrom)];
    }
  }
  return rec;
}

/**
 * @param {{home:string, managedText:string, volatileText:string, adapterTargets?:string[]}} o
 */
export function takeSnapshot(o) {
  const home = o.home;
  const managed = parseList(o.managedText);
  const volatile = parseList(o.volatileText);
  const vol = compileVolatile(volatile, home);
  const ctx = {
    home,
    vol,
    tilde: (p) => toTilde(p, home),
    paths: {},
    sources: {},
    meta: {},
    dirs: {},
    volatileExcluded: new Set(),
    realHome: realpathOrNull(home) ?? home,
    outsideLinks: new Set(),
    hashedBytes: 0,
    aliases: [],
  };
  const entries = [];
  const all = [
    ...managed.map((e) => ({ ...e, source: 'managed' })),
    ...(o.adapterTargets ?? []).flatMap((t) =>
      parseList(t).map((e) => ({ ...e, source: 'adapter' })),
    ),
  ];
  for (const e of all) {
    const abs = toAbsolute(e.pattern, home);
    entries.push(`${e.source}:${e.raw}`);
    if (e.isGlob) {
      const expanded = expandGlob(abs);
      const matches = expanded.filter((p) => !vol.isVolatile(p));
      for (const p of expanded) if (vol.isVolatile(p)) ctx.volatileExcluded.add(ctx.tilde(p));
      addPath(abs, { t: 'glob', expansion: matches.map((p) => ctx.tilde(p)) }, e.source, ctx);
      for (const p of matches) {
        const st = lstatOrNull(p);
        if (st && st.isDirectory() && !st.isSymbolicLink() && e.isDir) snapDir(p, e.source, ctx);
        else addPath(p, describe(p, ctx), e.source, ctx);
      }
    } else if (e.isDir) {
      snapDir(abs, e.source, ctx);
    } else {
      addPath(abs, describe(abs, ctx), e.source, ctx);
    }
  }
  if (o.homeWatch !== false) {
    // 防"命令绕过 HOME 环境变量、按 passwd 写真实 HOME":只看几个常见落点的直接子项名字表
    for (const w of HOME_WATCH) {
      const abs = toAbsolute(w, home);
      const ents = readdirNames(abs);
      const key = `watch:${w}`;
      const st = lstatOrNull(abs);
      if (st)
        ctx.meta[key] = { ctime_ms: Math.trunc(st.ctimeMs), mtime_ms: Math.trunc(st.mtimeMs) };
      ctx.paths[key] =
        ents === null
          ? { t: 'absent' }
          : {
              t: 'names',
              names: ents
                .map((e) => e.name)
                .filter((n) => !vol.isVolatile(path.join(abs, n)))
                .sort(),
            };
    }
  }
  const sortedPaths = Object.fromEntries(
    Object.entries(ctx.paths).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    version: 1,
    entries: [...new Set(entries)].sort(),
    paths: sortedPaths,
    sources: Object.fromEntries(
      Object.entries(ctx.sources)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, [...v].sort()]),
    ),
    meta: Object.fromEntries(Object.entries(ctx.meta).sort(([a], [b]) => (a < b ? -1 : 1))),
    dirs: Object.fromEntries(Object.entries(ctx.dirs).sort(([a], [b]) => (a < b ? -1 : 1))),
    outside_links: [...ctx.outsideLinks].sort(),
    stats: {
      entries: entries.length,
      recorded_paths: Object.keys(sortedPaths).length,
      volatile_excluded: ctx.volatileExcluded.size,
      ...(ctx.truncated ? { truncated: true } : {}),
    },
  };
}

// ---------- 比对 ----------
function canon(v) {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}

/** 差异:added(只在 after)、removed(只在 before)、changed(两边都在但记录不同)。meta 不参与比对。 */
export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const keys = new Set([...Object.keys(before.paths), ...Object.keys(after.paths)]);
  for (const k of [...keys].sort()) {
    const b = before.paths[k];
    const a = after.paths[k];
    if (b === undefined) added.push({ path: k, after: a });
    else if (a === undefined) removed.push({ path: k, before: b });
    else if (canon(a) !== canon(b)) changed.push({ path: k, before: b, after: a });
  }
  return { added, removed, changed, count: added.length + removed.length + changed.length };
}

/** adapter 声明的落点中,没被手写 managed 清单覆盖的(B07/B08 新增落点而没登记 => 报)。 */
export function findUncoveredAdapterTargets(managedText, adapterTargets, home) {
  const managed = parseList(managedText).map((e) => compileEntry(e, home));
  const out = [];
  for (const t of adapterTargets) {
    for (const e of parseList(t)) {
      const abs = toAbsolute(e.pattern, home);
      if (!e.pattern.startsWith('~') && !e.pattern.startsWith('/')) continue;
      if (!managed.some((m) => m.covers(abs))) out.push(e.raw);
    }
  }
  return out;
}

/** 读 adapters/<x>/managed-targets.json 的 managed_targets(只取字符串数组)。 */
export function readAdapterTargets(repo) {
  const dir = path.join(repo, 'adapters');
  const targets = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return { targets, skipped };
  }
  for (const n of names) {
    const f = path.join(dir, n, 'managed-targets.json');
    let j;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    for (const t of Array.isArray(j.managed_targets) ? j.managed_targets : []) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('~') || t.startsWith('/')) targets.push(t);
      else skipped.push(`${n}:${t}`); // 项目级相对路径,不在 HOME 快照范围
    }
  }
  return { targets: [...new Set(targets)].sort(), skipped };
}

export { findListConflicts };

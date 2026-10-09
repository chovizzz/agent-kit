// 受管路径快照 / 比对(A5 副判据)。只读:lstat / readdir / readlink / 读文件算 sha256;从不写 HOME。
// 报告里只放 `~/…` 形式的路径与哈希,不放文件内容。
//
// 快照记录(按 plan B17 要点):
//   - 字面文件:存在与否 + sha256;符号链接记录 readlink 目标,不跟随。
//   - 目录条目(以 / 结尾):顶层条目名列表 + 每个条目的 sha256(文件)/ readlink(符号链接)/
//     (子目录)SKILL.md 与其顶层普通文件的 sha256 + 子目录条目名列表。
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
/** 目录整棵树的「相对路径 + 类型 + 大小」摘要(不读内容、不跟随符号链接;volatile 剔除)。抓得到嵌套文件的增删与大小变化。 */
function treeDigest(root, vol) {
  const lines = [];
  let maxCtime = 0;
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
      if (vol.isVolatile(p)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const lst = lstatOrNull(p);
      if (lst) maxCtime = Math.max(maxCtime, Math.trunc(lst.ctimeMs));
      if (e.isSymbolicLink()) lines.push(`${r}\tL\t${readlinkOrNull(p) ?? ''}`);
      else if (e.isDirectory()) {
        lines.push(`${r}\tD`);
        walk(p, r);
      } else {
        lines.push(`${r}\tF\t${lst ? lst.size : -1}`);
      }
    }
  };
  walk(root, '');
  if (truncated) lines.push('TRUNCATED');
  return {
    digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
    maxCtime,
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
  if (st.isSymbolicLink()) return { t: 'symlink', link: readlinkOrNull(abs, ctx) };
  if (st.isFile()) return { t: 'file', size: st.size, sha: sha256File(abs, st.size) };
  if (st.isDirectory()) {
    const ents = readdirNames(abs);
    if (ents === null) return { t: 'dir', unreadable: true };
    noteDir(abs, st, ctx);
    const names = ents.map((e) => e.name).filter((n) => !ctx.vol.isVolatile(path.join(abs, n)));
    names.sort();
    const rec = { t: 'dir', names };
    const files = {};
    for (const e of ents) {
      if (!e.isFile() || ctx.vol.isVolatile(path.join(abs, e.name))) continue;
      const fst = lstatOrNull(path.join(abs, e.name));
      if (!fst) continue;
      files[e.name] = sha256File(path.join(abs, e.name), fst.size);
      ctx.meta[ctx.tilde(path.join(abs, e.name))] = {
        ctime_ms: Math.trunc(fst.ctimeMs),
        mtime_ms: Math.trunc(fst.mtimeMs),
      };
    }
    const tree = treeDigest(abs, ctx.vol);
    if (tree.truncated) ctx.truncated = true;
    rec.tree = tree.digest;
    if (Object.keys(files).length) rec.files = Object.fromEntries(Object.entries(files).sort());
    // 目录记录的 ctime 取「目录自身与其已哈希顶层文件」的最大值,归因时才不会漏掉只改文件内容的写入
    let c = Math.max(Math.trunc(st.ctimeMs), tree.maxCtime);
    for (const n of Object.keys(files))
      c = Math.max(c, ctx.meta[ctx.tilde(path.join(abs, n))]?.ctime_ms ?? 0);
    ctx.meta[ctx.tilde(abs)] = { ctime_ms: c, mtime_ms: Math.trunc(st.mtimeMs) };
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
  for (const e of visible) {
    const child = path.join(abs, e.name);
    // 子路径记录:用 real 目录下的同名项读取(符号链接目录本身时通过 real 访问)
    const readFrom = link !== null ? path.join(real, e.name) : child;
    addPath(child, describeChild(readFrom, child, ctx), source, ctx);
  }
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

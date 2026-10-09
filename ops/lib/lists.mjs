// 清单语法(设计 §10 P0 验收 5,修订 N9)与路径匹配。纯函数 + 只读 fs;不写任何东西。
//
// 行语义:
//   - 每行一个条目;空行与 `#` 开头的行忽略;`~` 展开为(真实)HOME。
//   - 行内含 `*` `?` `[` 时按 glob(`**` 跨目录(含隐藏目录),不跟随符号链接,
//     `*` `?` `[]` 不匹配以 `.` 开头的名字,除非模式本段自己以 `.` 开头);否则按字面路径。
//   - 以 `/` 结尾表示目录条目。
//   - 不以 `/` 或 `~` 开头的行锚定在 HOME 下(`**/.DS_Store` = `~/**/.DS_Store`)。
//   - volatile 清单只用于剔除:路径本身或其任一祖先命中任一 volatile 条目即被剔除。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const GLOB_CHARS = /[*?[]/;

/** 解析清单文本。返回 [{ raw, line, isDir, isGlob, pattern }],pattern 为未展开 ~ 的原文(去掉末尾 /)。 */
export function parseList(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const isDir = raw.endsWith('/');
    const pattern = isDir ? raw.replace(/\/+$/, '') : raw;
    entries.push({ raw, line: i + 1, isDir, isGlob: GLOB_CHARS.test(pattern), pattern });
  }
  return entries;
}

/** `~`、`~/x` -> 绝对;相对模式锚定 HOME。 */
export function toAbsolute(pattern, home) {
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return path.join(home, pattern.slice(2));
  if (pattern.startsWith('/')) return pattern;
  return path.join(home, pattern);
}

/** 把 HOME 前缀折回 `~`(报告里不写真实 HOME 路径)。 */
export function toTilde(abs, home) {
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~' + abs.slice(home.length);
  return abs;
}

// ---------- 单段 glob -> RegExp ----------
function segmentRegex(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
        continue;
      }
      let body = seg.slice(i + 1, end);
      let neg = false;
      if (body.startsWith('!') || body.startsWith('^')) {
        neg = true;
        body = body.slice(1);
      }
      body = body.replace(/[\\\]]/g, '\\$&');
      re += neg ? `[^${body}/]` : `[${body}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function segMatches(patSeg, name) {
  if (!GLOB_CHARS.test(patSeg)) return patSeg === name;
  if (name.startsWith('.') && !patSeg.startsWith('.')) return false; // bash 默认不匹配隐藏名
  return segmentRegex(patSeg).test(name);
}

function isHidden(name) {
  return name.startsWith('.');
}

/** 路径段数组是否整体匹配模式段数组。`**` = 零个或多个非隐藏目录段(位于末尾时 = 零个或多个任意非隐藏段)。 */
function matchSegs(pat, segs, pi = 0, si = 0, crossHidden = false) {
  if (pi === pat.length) return si === segs.length;
  const p = pat[pi];
  if (p === '**') {
    if (pi === pat.length - 1) {
      if (crossHidden) return true;
      for (let k = si; k < segs.length; k++) if (isHidden(segs[k])) return false;
      return true;
    }
    for (let k = si; k <= segs.length; k++) {
      if (matchSegs(pat, segs, pi + 1, k, crossHidden)) return true;
      if (k < segs.length && !crossHidden && isHidden(segs[k])) return false;
    }
    return false;
  }
  if (si >= segs.length) return false;
  if (!segMatches(p, segs[si])) return false;
  return matchSegs(pat, segs, pi + 1, si + 1, crossHidden);
}

function splitAbs(p) {
  return p.split('/').filter((s) => s !== '');
}

/**
 * 把清单条目编译成可复用的 { entry, abs, covers(absPath) }。
 * 匹配(剔除/覆盖判断)时 `**` 可跨隐藏目录(volatile 的意图是整棵子树);展开(expandGlob)仍按 bash 默认不进隐藏目录。
 */
export function compileEntry(entry, home) {
  const abs = toAbsolute(entry.pattern, home);
  const pat = splitAbs(abs);
  return {
    entry,
    abs,
    covers(absPath) {
      const segs = splitAbs(absPath);
      for (let n = segs.length; n >= 1; n--)
        if (matchSegs(pat, segs.slice(0, n), 0, 0, true)) return true;
      return false;
    },
    matchesExactly(absPath) {
      return matchSegs(pat, splitAbs(absPath), 0, 0, true);
    },
  };
}

export function compileVolatile(entries, home) {
  const list = entries.map((e) => compileEntry(e, home));
  return {
    list,
    isVolatile(absPath) {
      return list.some((c) => c.covers(absPath));
    },
  };
}

// ---------- glob 展开(只读 fs) ----------
function safeLstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 展开绝对 glob 模式,返回排序后的存在路径(lstat 存在)。不跟随符号链接目录。
 * `*` `?` `[]` 不匹配以 . 开头的名字(bash 默认);`**` 为求检测面更大,**会**进入隐藏目录(与 covers 的语义一致)。
 */
export function expandGlob(absPattern) {
  const segs = splitAbs(absPattern);
  const out = new Set();
  const collectAll = (dir) => {
    for (const d of safeReaddir(dir)) {
      const p = path.join(dir, d.name);
      out.add(p);
      if (d.isDirectory() && !d.isSymbolicLink()) collectAll(p);
    }
  };
  const rec = (dir, i) => {
    if (i === segs.length) {
      if (safeLstat(dir)) out.add(dir);
      return;
    }
    const seg = segs[i];
    if (seg === '**') {
      if (i === segs.length - 1) {
        if (safeLstat(dir)) out.add(dir);
        collectAll(dir);
        return;
      }
      rec(dir, i + 1);
      for (const d of safeReaddir(dir)) {
        if (d.isDirectory() && !d.isSymbolicLink()) rec(path.join(dir, d.name), i);
      }
      return;
    }
    if (!GLOB_CHARS.test(seg)) {
      rec(path.join(dir, seg), i + 1);
      return;
    }
    for (const d of safeReaddir(dir))
      if (segMatches(seg, d.name)) rec(path.join(dir, d.name), i + 1);
  };
  rec('/', 0);
  return [...out].sort();
}

// ---------- 清单合法性:禁止把 managed 路径挪进 volatile ----------
/**
 * 静态冲突检查:任一 managed 条目(字面/目录路径、glob 模式串、glob 现有展开)被 volatile 覆盖 => 冲突。
 * 返回 [{ code:'MANAGED_COVERED_BY_VOLATILE', managed, volatile, via }]
 */
export function findListConflicts(managedEntries, volatileEntries, home) {
  const vol = compileVolatile(volatileEntries, home);
  const conflicts = [];
  for (const m of managedEntries) {
    const abs = toAbsolute(m.pattern, home);
    const candidates = [{ p: abs, via: m.isGlob ? 'pattern' : 'path' }];
    if (m.isGlob) for (const p of expandGlob(abs)) candidates.push({ p, via: 'expansion' });
    for (const { p, via } of candidates) {
      const hit = vol.list.find((v) => v.covers(p));
      if (hit) {
        conflicts.push({
          code: 'MANAGED_COVERED_BY_VOLATILE',
          managed: m.raw,
          volatile: hit.entry.raw,
          via,
          path: toTilde(p, home),
        });
        break;
      }
    }
  }
  return conflicts;
}

const GIT_HYGIENE = [
  '-c',
  'user.name=zero-write',
  '-c',
  'user.email=zero-write@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.fsmonitor=false',
  '--no-optional-locks',
];

export function gitEnv(extra = {}) {
  return {
    PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

/** 读取 git ref 里某文件内容;ref 不含该文件 / 不是仓库 => null。只读。 */
export function gitShow(repo, ref, relPath) {
  const r = spawnSync('git', [...GIT_HYGIENE, '-C', repo, 'show', `${ref}:${relPath}`], {
    env: gitEnv(),
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout : null;
}

export function gitStatusPorcelain(repo) {
  const r = spawnSync(
    'git',
    [...GIT_HYGIENE, '-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'],
    { env: gitEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l !== '');
}

/**
 * 与基线(git ref)对比:
 *   MANAGED_MOVED_TO_VOLATILE: 基线 managed 里有、现在 managed 里没有、且现在被 volatile 覆盖/新增为 volatile 条目;
 *   MANAGED_REMOVED:           基线 managed 里有、现在没有(未被 volatile 覆盖)——同样要显式批准(--allow-managed-removal)。
 * baseManaged / baseVolatile: 文本(基线不存在时传 null => 不检查)。
 */
export function compareWithBase(baseManagedText, nowManagedText, nowVolatileText, home) {
  if (baseManagedText === null) return [];
  const base = parseList(baseManagedText);
  const nowSet = new Set(parseList(nowManagedText).map((e) => e.raw));
  const vol = compileVolatile(parseList(nowVolatileText), home);
  const out = [];
  for (const b of base) {
    if (nowSet.has(b.raw)) continue;
    const abs = toAbsolute(b.pattern, home);
    const hit = vol.list.find((v) => v.covers(abs));
    out.push(
      hit
        ? { code: 'MANAGED_MOVED_TO_VOLATILE', managed: b.raw, volatile: hit.entry.raw }
        : { code: 'MANAGED_REMOVED', managed: b.raw },
    );
  }
  return out;
}

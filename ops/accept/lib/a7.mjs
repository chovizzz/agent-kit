// A7 盘点复算:按编号重跑 inventory/commands.sh 的每条命令,与期望值逐项比对。
// 命令来自受版本控制的文件但仍会被执行,所以先过"只读"静态检查(allowlist + 引号感知;这是 lint,不是沙箱),
// 并带 pipefail 运行;命令自身报错(依赖文件缺失等)按"未执行 4"而不是"一致/不一致"。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Reporter, parseCommon, makeCtx, run, runMain } from './common.mjs';

const ALLOW_CMDS = new Set([
  'wc',
  'tr',
  'cut',
  'shasum',
  'sha256sum',
  'awk',
  'sed',
  'grep',
  'egrep',
  'ls',
  'find',
  'comm',
  'sort',
  'uniq',
  'paste',
  'cat',
  'head',
  'tail',
  'jq',
  'basename',
  'dirname',
  'readlink',
  'stat',
  'echo',
  'printf',
  'cd',
  'test',
  '[',
  '[[',
  'true',
  'false',
  'read',
  'continue',
  'break',
  'diff',
  'expr',
]);
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);
const SKIP_FIRST = new Set(['for', 'case', 'done', 'fi', 'esac', 'in', '}']);
const FIND_EXEC_OK = new Set(['shasum', 'sha256sum', 'wc', 'cat', 'stat', 'ls', 'grep']);
// awk 程序里的写文件/起进程构造。`NR>1` 之类的比较不算:重定向要求 > 或 >> 后面紧跟 " $ 字母 或 /。
const AWK_BAD = [
  /\bsystem\s*\(/,
  /\bgetline\b/,
  /\b(print|printf)\b[^;}']*>>?\s*("|\$|[A-Za-z_\/])/,
  /\b(print|printf)\b[^;}']*\|\s*"/,
  /\bclose\s*\(/,
];

/** 把命令拆成 { skeleton(引号内容换成 Q), quoted[] (单引号段), inner[] (双引号里的 $() 内部) }。 */
export function splitQuotes(cmd) {
  let skeleton = '';
  const single = [];
  const inner = [];
  const double = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') {
      skeleton += 'Q';
      i += 2;
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j === -1) return { error: '单引号未闭合' };
      single.push(cmd.slice(i + 1, j));
      skeleton += 'Q';
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      const start = j;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\') {
          j += 2;
          continue;
        }
        if (cmd[j] === '`') return { error: '双引号内出现反引号' };
        if (cmd[j] === '$' && cmd[j + 1] === '(' && cmd[j + 2] !== '(') {
          let depth = 1;
          let k = j + 2;
          while (k < cmd.length && depth > 0) {
            if (cmd[k] === '(') depth++;
            else if (cmd[k] === ')') depth--;
            k++;
          }
          if (depth !== 0) return { error: '双引号内 $( 未闭合' };
          inner.push(cmd.slice(j + 2, k - 1));
          j = k;
          continue;
        }
        j++;
      }
      if (j >= cmd.length) return { error: '双引号未闭合' };
      double.push(cmd.slice(start, j));
      skeleton += 'Q';
      i = j + 1;
    } else {
      skeleton += c;
      i++;
    }
  }
  return { skeleton, single, double, inner };
}

/** 返回问题列表(空 = 通过)。 */
export function lintCommand(cmd, depth = 0) {
  const problems = [];
  if (depth > 6) return ['嵌套过深'];
  if (cmd.includes('\0') || cmd.includes('\n')) return ['命令必须是单行'];
  const sq = splitQuotes(cmd);
  if (sq.error) return [sq.error];
  if (sq.skeleton.includes('`')) return ['禁止反引号'];
  if (/\bawk\b/.test(sq.skeleton)) {
    for (const q of [...sq.single, ...sq.double]) {
      for (const re of AWK_BAD) if (re.test(q)) problems.push(`awk 程序含禁用构造 ${re}`);
    }
  }
  for (const innerCmd of sq.inner) problems.push(...lintCommand(innerCmd, depth + 1));
  let sk = sq.skeleton.replace(/\$\(\([^()]*\)\)/g, '0');
  // 重定向:只允许写 /dev/null 与 fd 复制(2>&1 / >&2);其它 > >> &> 一律拒绝
  for (const m of sk.matchAll(/(\d*)(&>|>>?)(&?)(\s*)([^\s;|&)]*)/g)) {
    const target = m[5];
    const fdDup = m[3] === '&' && /^\d$/.test(target);
    if (m[2] === '&>' || !(fdDup || target === '/dev/null'))
      problems.push(`禁止重定向到 ${target || '文件'}`);
  }
  sk = sk
    .replace(/\d*>>?&\d/g, ' ')
    .replace(/\d*>>?\s*\/dev\/null/g, ' ')
    .replace(/\{\}/g, 'X');
  if (/(^|[^<])<<[^<]/.test(sk)) problems.push('禁止 heredoc');
  if (/\bsed\b[^|;]*\s(-[a-zA-Z]*i|--in-place)/.test(sk)) problems.push('禁止 sed -i');
  // sed 的 w / e 命令与 s///w、s///e 标志会写文件或执行命令;sort -o 会写文件
  if (/\bsed\b/.test(sq.skeleton)) {
    for (const q of [...sq.single, ...sq.double]) {
      if (
        /(^|[\s;{}])[we]\s*[\/\w$"'.-]/.test(q) ||
        /s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[a-zA-Z0-9]*[we]/.test(q)
      ) {
        problems.push('sed 程序含 w/e 命令或标志(会写文件/执行命令)');
      }
    }
  }
  if (/\bsort\b[^|;&]*\s(-[a-zA-Z]*o|--output|--compress-program)/.test(sk))
    problems.push('sort 带输出/外部程序选项');
  if (/\bfind\b/.test(sk)) {
    if (/\s-(delete|fprint\w*|fls|ok\w*)\b/.test(sk)) problems.push('find 含写/删除动作');
    for (const m of sk.matchAll(/\s-exec\w*\s+(\S+)/g)) {
      if (!FIND_EXEC_OK.has(m[1])) problems.push(`find -exec 不允许 ${m[1]}`);
    }
  }
  // 命令词
  const segs = sk.split(/\|\||&&|[|;&\n(){}]|<\(|\$\(/);
  for (const seg0 of segs) {
    let words = seg0.trim().split(/\s+/).filter(Boolean);
    while (words.length && (KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])))
      words.shift();
    if (words.length === 0) continue;
    let w = words[0].replace(/^\\/, '');
    if (SKIP_FIRST.has(w)) continue;
    if (w.includes('/')) {
      if (/^\/(usr\/)?bin\//.test(w)) w = path.basename(w);
      else {
        problems.push(`命令路径不允许:${w}`);
        continue;
      }
    }
    if (w === 'Q') {
      problems.push('命令词是引号串');
      continue;
    }
    if (!ALLOW_CMDS.has(w)) problems.push(`命令不在白名单:${w}`);
  }
  return [...new Set(problems)];
}

export function parseCommands(text) {
  const rows = [];
  const problems = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length !== 4) {
      problems.push(`第 ${i + 1} 行不是 4 列(制表符分隔)`);
      continue;
    }
    const [id, cmd, expected, at] = cols;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) problems.push(`第 ${i + 1} 行编号非法:${id}`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at))
      problems.push(`第 ${i + 1} 行时点不是 UTC ISO:${at}`);
    if (/^>=/.test(expected) && !/^>=\d+$/.test(expected))
      problems.push(`第 ${i + 1} 行 ">=" 期望值格式错:${expected}`);
    rows.push({ id, cmd, expected, at, line: i + 1 });
  }
  const ids = rows.map((r) => r.id);
  for (const d of new Set(ids.filter((x, i) => ids.indexOf(x) !== i)))
    problems.push(`编号重复:${d}`);
  return { rows, problems };
}

/** 比对;返回 { ok, note }。">=N" 是唯一的显式放宽规则。 */
export function compare(expected, actual) {
  if (/^>=\d+$/.test(expected)) {
    const n = Number(expected.slice(2));
    if (!/^\d+$/.test(actual))
      return {
        ok: false,
        note: `期望 ${expected},实得非整数 ${JSON.stringify(actual.slice(0, 40))}`,
      };
    const a = Number(actual);
    return a >= n
      ? { ok: true, note: `${a} >= ${n}(差值 +${a - n},已列出)` }
      : { ok: false, note: `${a} < ${n}` };
  }
  return actual === expected
    ? { ok: true, note: '' }
    : {
        ok: false,
        note: `期望 ${JSON.stringify(expected.slice(0, 80))} 实得 ${JSON.stringify(actual.slice(0, 80))}`,
      };
}

/** 命令引用的 ~/ 或 $HOME/ 根路径(无通配)是否存在;返回缺失列表。 */
export function missingInputs(cmd, home) {
  const out = new Set();
  for (const m of cmd.matchAll(/(?:~|\$HOME|\$\{HOME\})\/([^\s'"|;&)<>*?\[$]+)/g)) {
    const parts = m[1].split('/').filter(Boolean).slice(0, 2);
    const p = path.join(home, ...parts);
    if (!fs.existsSync(p)) out.add(`~/${parts.join('/')}`);
  }
  return [...out];
}

export function reportRefs(root) {
  const dir = path.join(root, 'inventory');
  const refs = new Set();
  if (!fs.existsSync(dir)) return refs;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    for (const m of fs
      .readFileSync(path.join(dir, f), 'utf8')
      .matchAll(/\[#([A-Za-z0-9][A-Za-z0-9_.-]*)\]/g))
      refs.add(m[1]);
  }
  return refs;
}

async function a7(argv) {
  const R = new Reporter('A7');
  const { flags } = parseCommon(argv, { value: ['commands', 'home'] });
  const ctx = makeCtx(flags);
  const file = path.resolve(flags.commands ?? path.join(ctx.root, 'inventory', 'commands.sh'));
  if (!fs.existsSync(file)) {
    R.rejected(`缺 ${file}`);
    return R.exit();
  }
  const { rows, problems } = parseCommands(fs.readFileSync(file, 'utf8'));
  if (problems.length || rows.length === 0) {
    for (const p of problems) R.rejected(`commands.sh:${p}`);
    if (rows.length === 0) R.rejected('commands.sh 没有任何命令');
    return R.exit();
  }
  let rejected = false;
  for (const r of rows) {
    const lp = lintCommand(r.cmd);
    if (lp.length) {
      R.rejected(`${r.id}: 命令未通过只读检查:${lp.join('; ')}`);
      rejected = true;
    }
  }
  if (rejected) return R.exit();

  const refs = reportRefs(ctx.root);
  const ids = new Set(rows.map((r) => r.id));
  const dangling = [...refs].filter((x) => !ids.has(x));
  if (dangling.length) R.fail(`报告引用了不存在的命令编号:${dangling.slice(0, 10).join(', ')}`);
  else if (refs.size === 0) R.fail('inventory/*.md 里没有任何 [#编号] 引用(报告与命令无法对应)');
  else R.pass(`报告引用 ${refs.size} 个编号,全部在 commands.sh 里`);
  const uncited = rows.filter((r) => !refs.has(r.id));
  if (uncited.length)
    R.info(
      `${uncited.length} 条命令未被报告引用(交叉验证用?):${uncited
        .slice(0, 5)
        .map((r) => r.id)
        .join(', ')}…`,
    );

  const home = flags.home ?? process.env.HOME ?? os.homedir();
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' };
  let ok = 0;
  for (const r of rows) {
    const miss = missingInputs(r.cmd, home);
    if (miss.length) {
      R.notRun(`${r.id}: 输入不存在(${miss.join(', ')}),无法复算`);
      continue;
    }
    const res = run('bash', ['-o', 'pipefail', '-c', r.cmd], {
      cwd: ctx.root,
      env,
      timeoutMs: 120_000,
    });
    if (res.spawnFailed || res.status === null) {
      R.notRun(`${r.id}: 命令未能正常结束(超时/信号)`);
      continue;
    }
    const stderr = res.stderr.trim();
    if (res.status !== 0) {
      // pipefail 下任何非零都说明某一段没跑成;输出恰好等于期望也不能当一致
      R.notRun(
        `${r.id}: 命令退出 ${res.status}${stderr ? `:${stderr.split('\n')[0].slice(0, 120)}` : '(无 stderr)'},不能当作复算一致`,
      );
      continue;
    }
    const actual = res.stdout.replace(/\n$/, '');
    const c = compare(r.expected, actual);
    if (c.ok) {
      ok++;
      if (c.note) R.info(`${r.id}: ${c.note}`);
    } else R.fail(`${r.id}: ${c.note}(时点 ${r.at})`);
  }
  R.info(`复算一致 ${ok}/${rows.length}`);
  if (ok === rows.length) R.pass(`全部 ${rows.length} 条命令复算一致`);
  return R.exit();
}

await runMain(import.meta.url, 'A7', () => a7(process.argv.slice(2)));

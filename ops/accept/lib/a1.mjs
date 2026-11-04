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
// 其它常见的非 ISO 日期时间写法。恒定的时间戳(构建产物里写死的某个日期)不影响确定性哈希,只有这里的扫描能抓到。
const SLASH_DATE = /(?<![0-9])20[0-9]{2}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12][0-9]|3[01])(?![0-9])/;
const WEEKDAY = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
// RFC 2822 / HTTP-date:`Mon, 01 Jan 2024`;ctime:`Mon Jan  1 10:00:00 2024`;`01 Jan 2024 10:00:00`
const RFC2822 = new RegExp(
  `(?:${WEEKDAY}),\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}` +
    `|(?:${WEEKDAY})\\s+(?:${MONTH})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}` +
    `|\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}`,
);
// epoch:只在两种上下文里认,不在任意数字上认(普通计数 / 大小 / id 也常是 10 位数,全文扫会大量误伤):
//  ① 键名像时间的键值对(JSON / YAML / TOML / env:`"generated_at": 1700000000`、`built=1700000000`);
//  ② 文件头部 20 行内的注释行里的独立数字。
// 键名按段匹配封闭词表(`candidate` `validate` `timeout` `builtins` `update_check` `timestamped` 都不算);路径里的日期分目录(out/2026/11/03/…)同样会被 SLASH_DATE 抓到:out/ 里不许有任何日期写法,是有意为之。
// 数值区间:秒 2001-01-01..2100-01-01(10 位),毫秒同区间(13 位);区间外的当普通数字。
const EPOCH_S = [978307200, 4102444800];
// 键名必须是「封闭的时间键形态」:按 _ - . 与驼峰切段后,有一段恰好是下面这些词之一(timeout / builtins / update_check / timestamped 都不是)
const TIME_WORDS = new Set([
  'time',
  'timestamp',
  'ts',
  'date',
  'datetime',
  'mtime',
  'ctime',
  'atime',
  'created',
  'updated',
  'generated',
  'built',
  'epoch',
]);
const KEY_VALUE =
  /["']?([A-Za-z][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*["']?([0-9]{10}|[0-9]{13})(?![0-9.])/g;
function isTimeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]/)
    .some((w) => TIME_WORDS.has(w));
}
const COMMENT_LINE = /^\s*(?:#|\/\/|--|;|\/\*|\*|<!--)/;
const BARE_EPOCH = /(?<![0-9A-Za-z_.-])([0-9]{10}|[0-9]{13})(?![0-9A-Za-z_.])/g;
function epochInRange(digits) {
  const n = Number(digits);
  const sec = digits.length === 13 ? n / 1000 : n;
  return sec >= EPOCH_S[0] && sec < EPOCH_S[1];
}

/** 文本里有没有时间戳:返回命中的写法名,没有返回 null。 */
export function timestampKind(text) {
  if (ISO_TS.test(text)) return 'ISO';
  if (SLASH_DATE.test(text)) return 'YYYY/MM/DD';
  if (RFC2822.test(text)) return 'RFC2822';
  for (const m of text.matchAll(KEY_VALUE))
    if (isTimeKey(m[1]) && epochInRange(m[2])) return 'epoch(键值)';
  const head = text.split('\n', 20);
  for (const line of head) {
    if (!COMMENT_LINE.test(line)) continue;
    for (const m of line.matchAll(BARE_EPOCH)) if (epochInRange(m[1])) return 'epoch(注释头)';
  }
  return null;
}

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
          const kind = timestampKind(s);
          if (kind !== null) hits.push(`${r}: 疑似时间戳(${kind})`);
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

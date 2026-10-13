// P1 验收总入口(A16–A20)与 A16–A19 共用的小工具。A1–A15 由 ops/accept-p0.sh 负责,语义不变;
// `--with-p0` 会在 A16–A20 之前先调用它做回归。A20 与 A13 同构:人工完成项,按标记文件判定。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  EXIT,
  UsageError,
  distSrc,
  mergeExit,
  parseFlags,
  runMain,
  DEFAULT_ROOT,
} from './common.mjs';
import { a20Status } from './a20.mjs';

export const ITEMS = [
  {
    id: 'A16',
    title: 'reflect 输出 schema 夹具矩阵(合法全过、非法逐条按原因码被拒)',
    script: 'a16.mjs',
  },
  { id: 'A17', title: '反思器改 hooks/ 或已有原子的夹具被路径守卫/G1/G2 拒', script: 'a17.mjs' },
  {
    id: 'A18',
    title: '同厂商评审被拒且不调用;全链失败时 judge_attempts 记满 5 跳',
    script: 'a18.mjs',
  },
  {
    id: 'A19',
    title: 'reflect/judge 干跑零写入(假 HOME + node --permission + 快照 + 金丝雀)',
    script: 'a19.mjs',
  },
  { id: 'A20', title: '变异抽检(6 处关键逻辑变异必须变红)', manual: true, doc: 'a20-mutation.md' },
];

const STATUS_NAME = {
  0: 'PASS',
  1: 'FAIL',
  2: 'USAGE',
  3: 'REJECTED',
  4: 'NOT-RUN',
  5: 'ATTRIBUTE',
};

/**
 * dist 必须比 src 新:A16–A19 直接 import / 运行 dist,陈旧的 dist 会让它们在旧代码上"通过"。
 * 返回 { ok, why }。
 */
export function freshDist(ctx) {
  const entry = path.join(distSrc(ctx), 'cli.js');
  if (!fs.existsSync(ctx.cli) || !fs.existsSync(entry))
    return { ok: false, why: `找不到 ${ctx.cli}(或 dist/src/cli.js):先 pnpm run build` };
  const built = Math.min(fs.statSync(ctx.cli).mtimeMs, fs.statSync(entry).mtimeMs);
  let newest = 0;
  let newestFile = '';
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) {
          newest = m;
          newestFile = p;
        }
      }
    }
  };
  const stale = [];
  const walkBak = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkBak(p);
      else if (e.name.endsWith('.mut-bak')) stale.push(path.relative(ctx.root, p));
    }
  };
  // tsconfig.build.json 编译 cli.ts、src/**、adapters/**;三处都要比
  for (const d of ['src', 'adapters']) {
    const abs = path.join(ctx.root, d);
    if (fs.existsSync(abs)) {
      walk(abs);
      walkBak(abs);
    }
  }
  const rootCli = path.join(ctx.root, 'cli.ts');
  if (fs.existsSync(rootCli) && fs.statSync(rootCli).mtimeMs > newest) {
    newest = fs.statSync(rootCli).mtimeMs;
    newestFile = rootCli;
  }
  if (stale.length > 0)
    return {
      ok: false,
      why: `发现上次变异没还原的备份:${stale.slice(0, 3).join(', ')}(先人工处理)`,
    };
  if (newest > built + 1000)
    return {
      ok: false,
      why: `dist 比 src 旧(${path.relative(ctx.root, newestFile)} 更新):先 pnpm run build`,
    };
  return { ok: true, why: '' };
}

/** import dist/src 下的模块(相对 dist/src 的路径,如 `reflect/validate.js`)。 */
export async function importDist(ctx, rel) {
  return import(pathToFileURL(path.join(distSrc(ctx), rel)).href);
}

export function listLines(root) {
  return ITEMS.map((it) => {
    if (it.manual) {
      const s = a20Status(root);
      return `${it.id.padEnd(4)} 【人工完成项】${it.title}  状态:${s.state === 'done' ? '已做' : '未做'}(${s.detail})  清单:ops/accept/${it.doc}`;
    }
    return `${it.id.padEnd(4)} ${it.title}  ops/accept/lib/${it.script}`;
  });
}

export function parseOnly(value) {
  const ids = value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (ids.length === 0) throw new UsageError('--only 需要至少一个编号');
  for (const id of ids)
    if (!ITEMS.some((i) => i.id === id))
      throw new UsageError(`未知编号 ${id}(有效:${ITEMS.map((i) => i.id).join(',')})`);
  return [...new Set(ids)];
}

async function p1Main(argv) {
  const { flags } = parseFlags(argv, {
    bool: ['list', 'help', 'with-p0'],
    value: ['only', 'root', 'cli'],
  });
  if (flags.help) {
    process.stdout.write(
      '用法:ops/accept-p1.sh [--list] [--only A16,A19] [--with-p0] [--root <仓库根>] [--cli <dist/cli.js>]\n' +
        '无参:依次运行 A16–A20(A20 为人工完成项,按标记文件判定)。--with-p0 先跑 ops/accept-p0.sh(A1–A15 回归)。\n' +
        '前置:pnpm run build(A16–A19 用 dist;dist 比 src 旧会按"未执行"处理)。任何 4(未执行)都按失败汇总。\n' +
        '退出码:0 全部通过 | 1 有违规 | 2 用法错 | 3 清单被拒 | 4 有未执行/人工项未完成 | 5 待人工归因\n',
    );
    return EXIT.OK;
  }
  const root = path.resolve(flags.root ?? DEFAULT_ROOT);
  if (flags.list) {
    process.stdout.write(listLines(root).join('\n') + '\n');
    return EXIT.OK;
  }
  const only = flags.only ? parseOnly(flags.only) : ITEMS.map((i) => i.id);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const results = [];
  const common = ['--root', root, ...(flags.cli ? ['--cli', flags.cli] : [])];
  if (flags['with-p0']) {
    process.stdout.write('\n=== A1–A15 回归(ops/accept-p0.sh)\n');
    const r = spawnSync('bash', [path.join(here, '..', '..', 'accept-p0.sh'), ...common], {
      stdio: 'inherit',
      env: process.env,
    });
    const code = r.status === null ? 4 : r.status;
    results.push({ id: 'P0', code: [0, 1, 2, 3, 4, 5].includes(code) ? code : 1, note: '' });
  }
  for (const it of ITEMS.filter((i) => only.includes(i.id))) {
    if (it.manual) {
      const s = a20Status(root);
      results.push({ id: it.id, code: s.state === 'done' ? 0 : 4, note: `人工完成项:${s.detail}` });
      process.stdout.write(
        `\n=== ${it.id} ${it.title}\n[${it.id}] ${s.state === 'done' ? 'PASS' : 'NOT-RUN'} 人工完成项:${s.detail}\n`,
      );
      continue;
    }
    process.stdout.write(`\n=== ${it.id} ${it.title}\n`);
    const r = spawnSync(process.execPath, [path.join(here, it.script), ...common], {
      stdio: 'inherit',
      env: process.env,
    });
    const code = r.status === null ? 4 : r.status;
    results.push({
      id: it.id,
      code: [0, 1, 2, 3, 4, 5].includes(code) ? code : 1,
      note: r.status === null ? '异常终止' : '',
    });
  }
  process.stdout.write('\n=== 汇总\n');
  for (const r of results)
    process.stdout.write(
      `${r.id.padEnd(4)} ${STATUS_NAME[r.code].padEnd(9)} exit=${r.code}${r.note ? `  ${r.note}` : ''}\n`,
    );
  const passed = results.filter((r) => r.code === 0).length;
  const failing = results.filter((r) => r.code !== 0);
  process.stdout.write(
    `通过 ${passed}/${results.length};未通过 ${failing.map((r) => r.id).join(',') || '无'}\n`,
  );
  if (failing.some((r) => r.code === 4))
    process.stdout.write('注意:4=未执行,按失败汇总,不是通过。\n');
  return mergeExit(results.map((r) => r.code));
}

await runMain(import.meta.url, 'accept-p1', () => p1Main(process.argv.slice(2)));

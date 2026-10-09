// A2 预算:12 格矩阵(脚本内硬编码期望,与 matrix.json 独立)+ vitest test/budget + 真实仓库 check 在 warn 下退出 0。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXIT_STUB,
  Reporter,
  cleanEnv,
  runMain,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  vitestStep,
  sandbox,
} from './common.mjs';

/** 期望矩阵(contracts.md §6 / plan A2):limit_source × enforce × 超 => 退出码。 */
export const EXPECTED = (() => {
  const cells = [];
  for (const ls of ['documented', 'probed', 'assumed']) {
    for (const enforce of ['warn', 'block']) {
      for (const over of [true, false]) {
        const blocking = over && enforce === 'block' && ls !== 'assumed';
        cells.push({ limit_source: ls, enforce, over, exit: blocking ? 1 : 0, hasDiag: over });
      }
    }
  }
  return cells;
})();

export function checkMatrix(matrix) {
  const problems = [];
  const cells = matrix?.cells;
  if (!Array.isArray(cells)) return ['matrix.json 缺 cells 数组'];
  if (cells.length !== 12) problems.push(`格数应为 12,实际 ${cells.length}`);
  const seen = new Set();
  for (const c of cells) {
    const key = `${c.limit_source}/${c.enforce}/${c.over}`;
    if (seen.has(key)) problems.push(`重复格 ${key}`);
    seen.add(key);
    const exp = EXPECTED.find(
      (e) => e.limit_source === c.limit_source && e.enforce === c.enforce && e.over === c.over,
    );
    if (!exp) {
      problems.push(`未知格 ${key}`);
      continue;
    }
    if (c.exit !== exp.exit) problems.push(`${key}: exit 应为 ${exp.exit},文件里是 ${c.exit}`);
    if (exp.hasDiag && !c.diagnostic) problems.push(`${key}: 超限格必须有告警诊断`);
    if (!exp.hasDiag && c.diagnostic) problems.push(`${key}: 不超的格不应有告警诊断`);
    if (exp.hasDiag && c.diagnostic) {
      const sev = exp.exit === 1 ? 'error' : 'warn';
      if (c.diagnostic.severity !== sev)
        problems.push(`${key}: 告警严重度应为 ${sev},文件里是 ${c.diagnostic.severity}`);
    }
  }
  for (const e of EXPECTED) {
    if (!seen.has(`${e.limit_source}/${e.enforce}/${e.over}`))
      problems.push(`缺格 ${e.limit_source}/${e.enforce}/${e.over}`);
  }
  return problems;
}

async function a2(argv) {
  const R = new Reporter('A2');
  const { flags } = parseCommon(argv, { bool: ['no-vitest'] });
  const ctx = makeCtx(flags);

  // 1) 矩阵文件
  const mFile = path.join(ctx.root, 'test', 'fixtures', 'budget', 'matrix.json');
  if (!fs.existsSync(mFile)) R.fail(`缺 ${path.relative(ctx.root, mFile)}`);
  else {
    let m;
    try {
      m = JSON.parse(fs.readFileSync(mFile, 'utf8'));
    } catch {
      m = null;
    }
    const problems = m ? checkMatrix(m) : ['matrix.json 不是合法 JSON'];
    if (problems.length) for (const p of problems) R.fail(`矩阵:${p}`);
    else R.pass('matrix.json 12 格与硬编码期望逐格一致');
  }

  // 2) kit.toml 默认 enforce=warn(用户决策 ②:P0 只告警)
  const kit = path.join(ctx.root, 'kit.toml');
  if (!fs.existsSync(kit)) R.fail('缺 kit.toml');
  else {
    const m = /^\s*enforce\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(kit, 'utf8'));
    if (!m) R.fail('kit.toml 没有 [budget].enforce');
    else if (m[1] !== 'warn') R.fail(`kit.toml enforce="${m[1]}",P0 必须是 "warn"(决策 ②)`);
    else R.pass('kit.toml enforce="warn"');
  }

  // 3) 真实仓库 check:warn 下退出 0 并打印各目标字节/行数
  if (!fs.existsSync(ctx.cli)) R.notRun(`找不到 CLI:${ctx.cli}`);
  else {
    const tmp = mkTmp(ctx, 'a2');
    try {
      const r = run(ctx.node, [ctx.cli, '--root', ctx.root, 'check'], {
        cwd: ctx.root,
        env: cleanEnv({ HOME: sandbox(tmp).home, KIT_TMP: sandbox(tmp).kit }),
      });
      if (r.status === EXIT_STUB) R.notRun('check 是命令桩(退出 64)');
      else if (r.status !== 0)
        R.fail(`check 退出 ${r.status}(warn 下应为 0) :: ${r.stderr.slice(0, 200)}`);
      else {
        const lines = r.stdout
          .split('\n')
          .filter((l) => /^budget (claude|codex|pi|kimi|opencode):.*字节.*行/.test(l));
        const agents = new Set(lines.map((l) => l.split(/[: ]/)[1]));
        if (agents.size < 5)
          R.fail(`check 没有打印 5 个目标的字节/行数(只有 ${[...agents].join(',') || '无'})`);
        else {
          R.pass('check 在 warn 下退出 0,并打印 5 个目标的字节/行数');
          for (const l of lines) R.info(`  ${l}`);
        }
      }

      // 4) vitest test/budget
      if (!flags.noVitest) {
        vitestStep(R, ctx, tmp, 'vitest test/budget', ['test/budget'], {
          files: { 'test/budget/matrix.test.ts': { min: 12, controls: 0 } },
          dirs: ['test/budget'],
        });
      }
    } finally {
      rmTmp(tmp);
    }
  }
  return R.exit();
}

await runMain(import.meta.url, 'A2', () => a2(process.argv.slice(2)));

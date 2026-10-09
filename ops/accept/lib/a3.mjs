// A3 脱敏:`redact --selftest` 与 `--selftest --mutate`(删任一规则至少一个种子变红)。
import * as fs from 'node:fs';
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
  sandbox,
} from './common.mjs';

/** 判定一次 selftest 的输出。返回 problems[]。 */
export function judgeSelftest(r, { mutate }) {
  const problems = [];
  if (r.status !== 0) problems.push(`退出 ${r.status}`);
  const lines = r.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (lines[lines.length - 1] !== 'SELFTEST OK') problems.push('末行不是 SELFTEST OK');
  if (lines.some((l) => /^(FAIL|MISS|LEAK|FALSE_POSITIVE)\b/i.test(l)))
    problems.push('输出含 FAIL/MISS 行');
  // 每类种子都要报 n/n 且分子==分母,且不能是 0/0
  const ratios = lines.filter((l) => /^seeds \w+: \d+\/\d+$/.test(l));
  if (ratios.length < 5) problems.push(`种子分类汇总行不足(${ratios.length} < 5)`);
  for (const l of ratios) {
    const [, a, b] = /: (\d+)\/(\d+)$/.exec(l);
    if (a !== b || b === '0') problems.push(`种子汇总异常:${l}`);
  }
  const recall = lines.find((l) => /^recall: \d+\/\d+$/.test(l));
  if (!recall) problems.push('缺 recall 行');
  else {
    const [, a, b] = /: (\d+)\/(\d+)$/.exec(recall);
    if (a !== b || b === '0') problems.push(`recall 不是 100%:${recall}`);
  }
  if (mutate) {
    const m = lines.find((l) => /^mutation killed: \d+\/\d+$/.test(l));
    if (!m) problems.push('缺 mutation killed 行');
    else {
      const [, a, b] = /: (\d+)\/(\d+)$/.exec(m);
      if (a !== b || b === '0') problems.push(`变异未全部被杀:${m}`);
    }
  }
  return problems;
}

async function a3(argv) {
  const R = new Reporter('A3');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);
  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 CLI:${ctx.cli}(先 pnpm run build)`);
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a3');
  try {
    for (const mutate of [false, true]) {
      const label = mutate ? 'redact --selftest --mutate' : 'redact --selftest';
      const args = [
        ctx.cli,
        '--root',
        ctx.root,
        'redact',
        '--selftest',
        ...(mutate ? ['--mutate'] : []),
      ];
      const r = run(ctx.node, args, {
        cwd: ctx.root,
        env: cleanEnv({ HOME: sandbox(tmp).home, KIT_TMP: sandbox(tmp).kit }),
      });
      if (r.spawnFailed) R.notRun(`${label}: CLI 无法启动(${ctx.cli})`);
      else if (r.status === EXIT_STUB) R.notRun(`${label}: 命令桩(退出 64)`);
      else {
        const problems = judgeSelftest(r, { mutate });
        if (problems.length) R.fail(`${label}: ${problems.join('; ')}`);
        else R.pass(`${label}: 种子全形态通过${mutate ? ',变异全部被杀' : ''}`);
      }
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A3', () => a3(process.argv.slice(2)));

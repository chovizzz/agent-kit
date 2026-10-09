// A4 冲突/守卫 fixture:vitest test/merge test/guards,且关键文件与"正向控制"用例必须真的跑过。
import { Reporter, makeCtx, mkTmp, parseCommon, rmTmp, runMain, vitestStep } from './common.mjs';

export const SPEC = {
  files: {
    'test/merge/merge.test.ts': { min: 10, controls: 2 },
    'test/guards/g1.test.ts': { min: 3, controls: 1 },
    'test/guards/g2.test.ts': { min: 3, controls: 1 },
    'test/guards/g3.test.ts': { min: 1, controls: 1 },
    'test/guards/g4.test.ts': { min: 1, controls: 0 },
    'test/guards/evasion.test.ts': { min: 3, controls: 1 },
    'test/guards/path-guard.test.ts': { min: 1, controls: 0 },
  },
  dirs: ['test/merge', 'test/guards'],
};

async function a4(argv) {
  const R = new Reporter('A4');
  const { flags } = parseCommon(argv, { value: ['spec-json'] });
  const ctx = makeCtx(flags);
  const tmp = mkTmp(ctx, 'a4');
  try {
    vitestStep(R, ctx, tmp, 'vitest test/merge test/guards', ['test/merge', 'test/guards'], SPEC);
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A4', () => a4(process.argv.slice(2)));

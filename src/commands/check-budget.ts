import { stubExit } from './types.js';
import type { CheckStep } from './types.js';

/** 命令桩:由块 B05 替换本文件内容,保持 `run` 的签名不变。 */
export const run: CheckStep = async (ctx) => {
  return stubExit(ctx, 'check (budget)', 'P0 内由块 B05 实装,当前是命令桩');
};

// A6(R20-17.20):doctor 只许经只读出口 hooks-read.ts 读钩子区;直接 import 写出口 hooks-fs.ts 必须被 eslint 拦下(本样本代表 doctor 侧的违规写法)
import { HooksFs } from '../../../src/io/hooks-fs.js';

export const probe = (home: string) => new HooksFs({ home });

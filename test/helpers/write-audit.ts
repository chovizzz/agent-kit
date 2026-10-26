import type { WriteAudit } from '../../src/io/paths.js';

export interface AuditCall {
  op: string;
  path: string;
}

/**
 * 零写入断言用的审计记录器:`calls` 是外部数组(命令内部 try/catch 吞异常也不影响记录)。
 * 用法:`const a = withWriteAudit(); main(argv, { ...a.mainEnv })` 或 `createIoContext({ writeAudit: a.hook })`
 * / `narrowCtx(dir, sub, a.hook)`。零写入断言:`expect(a.calls).toEqual([])`。
 */
export function withWriteAudit(): {
  hook: WriteAudit;
  /** 可直接展开进 MainEnv */
  mainEnv: { writeAudit: WriteAudit };
  calls: AuditCall[];
  reset(): void;
} {
  const calls: AuditCall[] = [];
  const hook: WriteAudit = (op, p) => {
    calls.push({ op, path: p });
  };
  return {
    hook,
    mainEnv: { writeAudit: hook },
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
}

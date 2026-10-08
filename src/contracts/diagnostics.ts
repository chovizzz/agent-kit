import { z } from 'zod';

/**
 * 稳定诊断码:`<DOMAIN>_<NAME>`,大写下划线。
 * 预留前缀:SCHEMA_ ATOM_ SKILL_ AGENT_ MERGE_ BUDGET_ GUARD_ REDACT_ READER_ CFG_ IO_ RENDER_
 * fixture 的 expect.json 断言的是 code,不是 message,所以 code 一旦发布不得改名。
 */
export const DiagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/);

export const DiagnosticSchema = z.strictObject({
  code: DiagnosticCodeSchema,
  severity: z.enum(['error', 'warn']),
  /** 出问题的文件或字段路径(仓库内相对路径,字段用 `#/a/b` 形式追加) */
  path: z.string(),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export function hasErrors(ds: readonly Diagnostic[]): boolean {
  return ds.some((d) => d.severity === 'error');
}

/** 确定性排序:path → code → message(字节序,不用 localeCompare)。 */
export function sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...ds].sort(
    (a, b) => cmp(a.path, b.path) || cmp(a.code, b.code) || cmp(a.message, b.message),
  );
}

/** zod 校验失败 → 统一的 SCHEMA_INVALID 诊断。各块在此之上再追加自己的 lint 诊断。 */
export function zodIssuesToDiagnostics(error: z.ZodError, filePath: string): Diagnostic[] {
  return sortDiagnostics(
    error.issues.map((i) => ({
      code: 'SCHEMA_INVALID',
      severity: 'error' as const,
      path: i.path.length > 0 ? `${filePath}#/${i.path.join('/')}` : filePath,
      message: i.message,
    })),
  );
}

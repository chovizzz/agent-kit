/**
 * 撤销凭据的**只读**端口适配器({@link RevocationReader};装配块 A 段)。写侧实现(`rollback-ports.ts` 的 `homeRevocationReader`)建在含写函数的 `home-state.ts` 上,不能进读侧闭包;
 * 本适配器建在 HOME 读端口({@link HomeReadPort},句柄级安全读取)与 `permit-read.ts` 的同一份解析之上,**同一契约**:
 * 文件不存在 = `ok []`(没有凭据);读不到 / 不安全 / 超限 / 缺尾换行 / 任一行不合规 = `invalid`(调用方不得授予任何影响,R21-6.11 第 4a 行)。**读失败绝不冒充空**。
 */
import type { HomeReadPort, RawRead } from '../../auto/read/ports.js';
import { parseRevocations } from '../../canary/permit-read.js';
import type { RevocationReader } from '../candidate-ports.js';

export function makeRevocationReadAdapter(
  home: Pick<HomeReadPort, 'revocations'>,
): RevocationReader {
  return {
    async read() {
      let raw: RawRead;
      try {
        raw = await home.revocations();
      } catch {
        return { kind: 'invalid', why: 'unreadable' };
      }
      if (raw.kind === 'absent') return { kind: 'ok', lines: [] };
      if (raw.kind === 'unreadable') return { kind: 'invalid', why: 'unreadable' };
      const p = parseRevocations(raw.text);
      return p.kind === 'ok' ? { kind: 'ok', lines: p.value } : { kind: 'invalid', why: 'parse' };
    },
  };
}

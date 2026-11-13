/**
 * hint `--canary` 判定层看到的许可端口(窄接口;依赖倒置):判定函数(`canary-decide.ts`)只依赖这里的类型,
 * 文件读取适配器(`permit-read.ts`)实现它,测试用内存假件实现它——假件与生产实现遵守同一份契约:读失败 = `unreadable`,从不返回「空」冒充成功。
 */
import type {
  CanaryAdmission,
  CanaryDoc,
  RsiRevocationLine,
} from '../../contracts/rsi-personal.js';

export type Read3<T> = { kind: 'absent' } | { kind: 'ok'; value: T } | { kind: 'unreadable' };
export type PauseRead = 'absent' | 'present' | 'unreadable';

/** hint 看到的四个输入,惰性读取(判定顺序决定哪些会被读到);`pause()` = `AUTO_PAUSE`(用户)与 `AUTO_PAUSE_BREAKER`(worker 熔断)两个标记的合并:任一在 → present,否则任一读失败 → unreadable */
export interface PermitPort {
  pause(): Promise<PauseRead>;
  admission(): Promise<Read3<CanaryAdmission>>;
  canary(): Promise<Read3<CanaryDoc>>;
  revocations(): Promise<Read3<readonly RsiRevocationLine[]>>;
}

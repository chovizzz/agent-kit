/**
 * `CacheCleanup` 的真实现(装配块 B2;回滚第二段「授予缓存清理」,R21-9.1 / R21-9.5):复用对账的缓存清理部分(`reconcileCaches`:去掉 `canary.json` 里被凭据列出的条目、补 stop 行,同 `revocation_ref` 不重复)。
 * **锁绑定**:只在一次持有 `rsi/lock` 的期间可用(`assertInsideLocks`);**必须发生在撤销凭据落盘之后**(执行器顺序保证),这里再读一次凭据取该 `(id, sha)` 的那一行——
 * 读不出 / 找不到 = 抛错(第二段判据不成立,journal 保留,下次续做),**不**返回 `cleaned`。缩减入口(`rsi auto clear`)不装配本端口(恒 `pending`,不访问仓库 `.state`)。
 */
import type { IoContext } from '../../io/paths.js';
import { reconcileCaches } from '../canary/canary-writer.js';
import type { RsiDirResolver } from '../canary/state-port.js';
import { assertInsideLocks, type CommandLockContext } from '../auto/write/command-locks.js';
import type { RevocationReader } from './candidate-ports.js';
import type { CacheCleanResult, CacheCleanup } from './rollback-ports.js';

export interface CacheCleanupDeps {
  io: IoContext;
  rsiDir: RsiDirResolver;
  locks: Pick<CommandLockContext, 'current'>;
  revocations: RevocationReader;
  /** 停止行的 `at`(仅展示;装配注入时钟) */
  now: () => Date;
}

export function makeCacheCleanup(d: CacheCleanupDeps): CacheCleanup {
  return {
    async clean(c): Promise<CacheCleanResult> {
      const held = await assertInsideLocks(d.locks, true);
      const rv = await d.revocations.read();
      if (rv.kind !== 'ok') throw new Error('cache_cleanup: revocations_unreadable');
      const line = rv.lines.find(
        (l) => l.candidate_id === c.candidate_id && l.content_sha256 === c.content_sha256,
      );
      if (line === undefined) throw new Error('cache_cleanup: revocation_missing');
      const dir = await d.rsiDir();
      if (dir === null) throw new Error('cache_cleanup: state_dir_missing');
      await reconcileCaches(
        { io: d.io, rsiDir: dir, locks: { rsi: held.rsi as NonNullable<typeof held.rsi> } },
        [line],
        d.now(),
      );
      return 'cleaned';
    },
  };
}

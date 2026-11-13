/**
 * HOME 侧个人层状态的只读端口实现({@link HomeReadPort} 的生产适配器;只用 `read-fs` 的句柄级安全读取,**没有任何写出口**,闭包里没有 home-fs / safe-fs / 锁)。
 * 路径 = `<HOME>/.local/state/agent-kit/rsi-personal/{head.json, revocations.jsonl, txn/<id>.json}`(与 `home-state.ts` 同一位置,测试钉住两处常量相等)。
 * 读失败(不安全 / 超限 / I/O)= `unreadable`,**不**当成「不存在」;只有 ENOENT 才是 `absent`。
 */
import * as path from 'node:path';
import { RSI_REVOCATIONS_MAX_BYTES } from '../../../contracts/rsi.js';
import { readDir, readFileSafe } from '../../../io/read-fs.js';
import type { HomeReadPort, RawRead } from '../../auto/read/ports.js';

/** HOME 相对:个人层状态目录(与 `home-state.ts` 的 `PERSONAL_STATE_REL` 相同) */
export const PERSONAL_STATE_REL_READ = '.local/state/agent-kit/rsi-personal';
const OWNER = { maxPerm: 0o600 } as const;
const TXN_FILE_RE = /^([0-9a-f]{16})\.json$/;
const TXN_ID_RE = /^[0-9a-f]{16}$/;
const JOURNAL_MAX_BYTES = 256 * 1024;

async function readRaw(file: string, maxBytes: number): Promise<RawRead> {
  try {
    const r = await readFileSafe(file, { maxBytes, owner: OWNER });
    if (r.kind === 'ok') return { kind: 'ok', text: r.bytes.toString('utf8') };
    return r.kind === 'missing' ? { kind: 'absent' } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function makeHomeReadPort(home: string): HomeReadPort {
  const dir = path.join(home, ...PERSONAL_STATE_REL_READ.split('/'));
  return {
    head: () => readRaw(path.join(dir, 'head.json'), 64 * 1024),
    revocations: () => readRaw(path.join(dir, 'revocations.jsonl'), RSI_REVOCATIONS_MAX_BYTES),
    async txnNames() {
      try {
        const entries = await readDir(path.join(dir, 'txn'));
        const names = entries
          .map((e) => TXN_FILE_RE.exec(path.basename(e.name))?.[1])
          .filter((x): x is string => x !== undefined)
          .sort();
        return { kind: 'ok', names };
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? { kind: 'ok', names: [] }
          : { kind: 'unreadable' };
      }
    },
    async journal(txnId) {
      if (!TXN_ID_RE.test(txnId)) return { kind: 'unreadable' };
      return readRaw(path.join(dir, 'txn', `${txnId}.json`), JOURNAL_MAX_BYTES);
    },
  };
}

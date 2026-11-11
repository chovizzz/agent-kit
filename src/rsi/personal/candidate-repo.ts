/**
 * 权威副本端口的真实适配器:私有仓库 `lifecycle/<id>.json`(R21-3.8)。读 = `readPersonalFiles`,写 = W2 的 `commitPersonal`。
 * 本文件不直接碰 git(git 出口只在 W2 的三个授权文件里)。
 *
 * 任何 `lifecycle/*.json` 解析失败 / schema 不过 / 文件名与记录 id 不一致 → 整个读取按 `invalid` 处理(`candidate_invalid`,安全阻断):
 * 不跳过坏记录继续,因为名额(R21-6.8)与聚类退火(G7)的判定依赖「全部记录」,少读一条就可能放过两个并行评估。
 */
import { PersonalLifecycleRecordSchema } from '../../contracts/rsi-personal.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import {
  commitPersonal,
  readPersonalFiles,
  type PersonalLocks,
  type PersonalRepoDeps,
} from './commit.js';
import type { AuthoritativeStore, RecordRead, RepoRead } from './candidate-ports.js';

export function personalRepoStore(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
): AuthoritativeStore {
  async function readAll(): Promise<RepoRead<PersonalLifecycleRecord[]>> {
    const r = await readPersonalFiles(deps, locks, ['lifecycle']);
    if (r.status === 'absent') return { kind: 'absent' };
    if (r.status === 'deferred') return { kind: 'deferred', reason: r.reason, why: r.why };
    if (r.status === 'invalid') return { kind: 'invalid', why: r.why };
    const records: PersonalLifecycleRecord[] = [];
    for (const f of r.files) {
      const m = /^lifecycle\/([^/]+)\.json$/.exec(f.path);
      if (m === null) return { kind: 'invalid', why: 'candidate_invalid' };
      let raw: unknown;
      try {
        raw = JSON.parse(f.content);
      } catch {
        return { kind: 'invalid', why: 'candidate_invalid' };
      }
      const p = PersonalLifecycleRecordSchema.safeParse(raw);
      if (!p.success || p.data.id !== m[1]) return { kind: 'invalid', why: 'candidate_invalid' };
      records.push(p.data);
    }
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { kind: 'ok', head: r.head, value: records };
  }
  return {
    readAll,
    async read(id): Promise<RecordRead> {
      const all = await readAll();
      if (all.kind !== 'ok') return all;
      const rec = all.value.find((x) => x.id === id);
      return rec === undefined
        ? { kind: 'missing', head: all.head }
        : { kind: 'ok', head: all.head, record: rec };
    },
    commit: (spec) => commitPersonal(deps, locks, spec),
  };
}

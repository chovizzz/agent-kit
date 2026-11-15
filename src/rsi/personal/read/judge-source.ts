/**
 * 判官裁决读端口 {@link ProposalJudgeSource} 的生产适配器(contracts R20-18.34 ① ②、R20-18.36、W0-27;**只读、零写入**)。
 *
 * 做的事:① `reflect/<run_id>/` 是真实目录、无 `TAINTED`、归属按当前排除与索引现算为「采集中」(`stagedRuns`,由调用方注入的 `attribution` 提供 `counts.staged` 与分类器);
 * ② 提案 `proposals/<proposal_id>.yaml` 与同 run 的 `rules/personal/<target>.md` 只经 `readFileSafe`(不跟随末级链接、普通文件、`nlink = 1`、属主当前 uid、≤ 64 KiB;不用 `judge/store.ts` 的读写原语,
 * 也不用 `loadRunEntries`——它一份坏提案就整 run 抛错);YAML 经 judge store 同一个受限解析器。③–⑥ 由纯函数 `judge-signal.ts` 做。
 *
 * **一致性协议(尽力检测,不是原子快照)**:读之前记下各目录 / 文件的身份(dev、ino,文件另含 size、mtime),读完后重新 stat 并**重做一次归属判定与 `TAINTED` 检查**;
 * 任何不一致 → `unreadable('race')`;回读时文件的安全属性(普通文件、`nlink = 1`、属主、大小上限)也重新核对,不合格 → `unreadable('recheck_unsafe')`(读期间被加了硬链接不改身份元数据,不能只比身份)(不得降为「无裁决」)。检测不到同 inode 内容被换回原样的 ABA(同 UID 进程可做到,R21-1.8 的既有残余),本模块只收紧,不据此放行。
 * 每次读之间检查 `signal`(2 秒预算由 `judge-signal.ts` 的 `readJudgeVerdict` 持有):已中止 → `unreadable('timeout')`。
 *
 * 失败分类:归属为「采集中」的 run 里,提案目录 / 文件读不出(含不存在、过大、链接、属主不符)一律 `unreadable`(无从判断是否曾有 reject);YAML 解析失败 / 非对象 = `invalid`;
 * run 目录不存在 = `run_gone`;被 taint / 非采集中 = `run_excluded`。
 *
 * import 闭包:read-fs、contracts、`pending.ts`(`stagedRuns`)、`atoms/frontmatter.ts`(受限 YAML 解析,纯);**不含**任何写出口 / 锁 / 子进程 / `judge/store.ts`。
 */
import * as path from 'node:path';
import { parseRestrictedYaml } from '../../../atoms/frontmatter.js';
import { KebabIdSchema, RunIdSchema } from '../../../contracts/common.js';
import type { RsiCounts } from '../../../contracts/rsi.js';
import {
  lstat,
  readFileSafe,
  statDirSafe,
  type OwnerPolicy,
  type SafeDirResult,
} from '../../../io/read-fs.js';
import { stagedRuns, type Classify } from '../../pending.js';
import type { JudgeSourceRead, ProposalJudgeSource } from '../judge-signal.js';

/** 单个提案 / 规则文件的字节上限(R20-18.34 ②,与 `pending.ts` 同族) */
export const JUDGE_SOURCE_MAX_BYTES = 64 * 1024;
const TAINT_MAX_BYTES = 4096;
/** 只校验属主(当前 uid);暂存文件的权限位不在契约要求内 */
const OWNER: OwnerPolicy = { maxPerm: 0o777 };
const PROPOSAL_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{3}$/;

export interface JudgeAttribution {
  /** `counts.json` 的 `staged` */
  staged: RsiCounts['staged'];
  /** 当前排除与索引现算的归属分类器 */
  classify: Classify;
}

export interface JudgeSourceDeps {
  /** `<repo>/.state`(`reflect/` 的父目录) */
  stateDir: string;
  /** 每次调用现算归属(读不到 → 抛错,适配器映射为 `unreadable`);**不缓存** */
  attribution(): Promise<JudgeAttribution>;
  /** 测试缝:读完之后、重新核对之前(演练「读期间被换」) */
  seam?: { afterReads?: () => Promise<void> | void };
}

interface Ident {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** 两次目录检查是否指向同一个目录(都不存在也算没变;`withTime` = 连同 mtime:目录里增删条目会改它) */
const dirSame = (before: SafeDirResult, after: SafeDirResult, withTime: boolean): boolean => {
  if (before.kind === 'missing' && after.kind === 'missing') return true;
  if (before.kind !== 'ok' || after.kind !== 'ok') return false;
  return (
    before.meta.dev === after.meta.dev &&
    before.meta.ino === after.meta.ino &&
    (!withTime || before.meta.mtimeMs === after.meta.mtimeMs)
  );
};

/**
 * 末次回读的安全属性(与首读 `readFileSafe` 同口径,且不依赖身份 / 内容元数据:读期间新增硬链接不改 dev / ino / size / mtime):
 * 普通文件、`nlink === 1`、属主 = 当前 uid(与 `OWNER` 策略相同;平台没有 getuid 时不校验)、大小不超上限。返回不合格的原因,合格 = `null`。
 */
export function recheckUnsafe(
  st: { isFile(): boolean; nlink: number; uid: number; size: number },
  uid: number | undefined,
  maxBytes: number,
): 'not_regular' | 'hardlink' | 'owner' | 'too_large' | null {
  if (!st.isFile()) return 'not_regular';
  if (st.nlink !== 1) return 'hardlink';
  if (uid !== undefined && st.uid !== uid) return 'owner';
  if (st.size > maxBytes) return 'too_large';
  return null;
}

const fileSame = (a: Ident | null, b: Ident | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
};

const bad = (why: string): JudgeSourceRead => ({ kind: 'unreadable', why });

export function makeProposalJudgeSource(deps: JudgeSourceDeps): ProposalJudgeSource {
  return {
    async read(runId, proposalId, ctl): Promise<JudgeSourceRead> {
      const aborted = (): boolean => ctl.signal.aborted;
      const reflect = path.join(deps.stateDir, 'reflect');
      const runDir = path.join(reflect, runId);
      const propDir = path.join(runDir, 'proposals');
      const rulesDir = path.join(runDir, 'rules', 'personal');
      const taintFile = path.join(runDir, 'TAINTED');

      // 归属判定(读前、读后各做一次;同一份逻辑)
      const attribute = async (): Promise<'consumable' | 'excluded' | JudgeSourceRead> => {
        const t = await readFileSafe(taintFile, { maxBytes: TAINT_MAX_BYTES, owner: OWNER });
        if (t.kind === 'ok') return 'excluded';
        if (t.kind === 'unsafe') return bad(`taint_marker_${t.why}`);
        let a;
        try {
          a = await deps.attribution();
        } catch {
          return bad('attribution');
        }
        return stagedRuns(a.staged, a.classify).some((r) => r.runId === runId)
          ? 'consumable'
          : 'excluded';
      };

      // 调用方给的坏 id / run id(路径穿越等)= 来源链接损坏:在任何读取之前拒绝,归读不出
      if (!RunIdSchema.safeParse(runId).success) return bad('run_id_shape');
      if (!PROPOSAL_ID_RE.test(proposalId)) return bad('proposal_id_shape');
      if (aborted()) return bad('timeout');
      // ① 目录:`reflect/` 与 run 目录必须是真实目录(O_DIRECTORY | O_NOFOLLOW)
      const dReflect = await statDirSafe(reflect, { owner: OWNER });
      if (dReflect.kind === 'missing') return { kind: 'run_gone' };
      if (dReflect.kind === 'unsafe') return bad(`reflect_dir_${dReflect.why}`);
      const dRun = await statDirSafe(runDir, { owner: OWNER });
      if (dRun.kind === 'missing') return { kind: 'run_gone' };
      if (dRun.kind === 'unsafe') return bad(`run_dir_${dRun.why}`);

      const first = await attribute();
      if (first === 'excluded') return { kind: 'run_excluded' };
      if (first !== 'consumable') return first;
      if (aborted()) return bad('timeout');

      // ② 提案(采集中的 run 里提案目录 / 文件缺失 = 读不出,不是「无裁决」)
      const dProp = await statDirSafe(propDir, { owner: OWNER });
      if (dProp.kind === 'missing') return bad('proposals_dir_missing');
      if (dProp.kind === 'unsafe') return bad(`proposals_dir_${dProp.why}`);
      const propFile = path.join(propDir, `${proposalId}.yaml`);
      const pr = await readFileSafe(propFile, { maxBytes: JUDGE_SOURCE_MAX_BYTES, owner: OWNER });
      if (pr.kind === 'missing') return bad('proposal_missing');
      if (pr.kind === 'unsafe') return bad(`proposal_${pr.why}`);
      const propIdent: Ident = {
        dev: pr.meta.dev,
        ino: pr.meta.ino,
        size: pr.meta.size,
        mtimeMs: pr.meta.mtimeMs,
      };
      // 内容类失败先记下、不提前返回:读后一致性核对对所有路径一视同仁(读到一半被换的半份 YAML 不得被当成稳定的内容错误)
      let fail: JudgeSourceRead | null = null;
      let value: unknown = null;
      const y = parseRestrictedYaml(
        pr.bytes.toString('utf8'),
        `proposals/${proposalId}.yaml`,
        'JUDGE_PROPOSAL_YAML',
      );
      if (!y.ok) {
        fail = { kind: 'invalid', why: 'yaml' };
      } else if (typeof y.value !== 'object' || y.value === null || Array.isArray(y.value)) {
        fail = { kind: 'invalid', why: 'not_object' };
      } else {
        value = y.value;
      }
      if (aborted()) return bad('timeout');

      // ② 规则:`rules/personal/<targets[0]>.md`(目标名取不出就不读,③ 会拒绝这份提案)
      const targets = fail === null ? (value as Record<string, unknown>)['targets'] : undefined;
      const target =
        Array.isArray(targets) &&
        targets.length === 1 &&
        typeof targets[0] === 'string' &&
        KebabIdSchema.safeParse(targets[0]).success
          ? targets[0]
          : null;
      let rule: { target: string; text: string } | null = null;
      let ruleIdent: Ident | null = null;
      let dRulesTop: SafeDirResult | null = null;
      let dRules: SafeDirResult | null = null;
      const rulesTop = path.join(runDir, 'rules');
      if (target !== null) {
        dRulesTop = await statDirSafe(rulesTop, { owner: OWNER });
        if (dRulesTop.kind === 'unsafe') return bad(`rules_dir_${dRulesTop.why}`);
        if (dRulesTop.kind === 'ok') {
          dRules = await statDirSafe(rulesDir, { owner: OWNER });
          if (dRules.kind === 'unsafe') return bad(`rules_dir_${dRules.why}`);
        }
        if (dRules !== null && dRules.kind === 'ok') {
          const rr = await readFileSafe(path.join(rulesDir, `${target}.md`), {
            maxBytes: JUDGE_SOURCE_MAX_BYTES,
            owner: OWNER,
          });
          if (rr.kind === 'unsafe') return bad(`rule_${rr.why}`);
          if (rr.kind === 'ok') {
            rule = { target, text: rr.bytes.toString('utf8') };
            ruleIdent = {
              dev: rr.meta.dev,
              ino: rr.meta.ino,
              size: rr.meta.size,
              mtimeMs: rr.meta.mtimeMs,
            };
          }
        }
      }

      await deps.seam?.afterReads?.();
      if (aborted()) return bad('timeout');

      // 一致性核对:目录身份、两个文件的 lstat 身份、归属与 TAINTED 重做
      const racy = (): JudgeSourceRead => bad('race');
      const again = (d: string): Promise<SafeDirResult> => statDirSafe(d, { owner: OWNER });
      if (!dirSame(dReflect, await again(reflect), false)) return racy();
      if (!dirSame(dRun, await again(runDir), true)) return racy();
      if (!dirSame(dProp, await again(propDir), true)) return racy();
      if (dRulesTop !== null && !dirSame(dRulesTop, await again(rulesTop), false)) return racy();
      if (dRules !== null && !dirSame(dRules, await again(rulesDir), true)) return racy();
      // 文件身份:只有 ENOENT 算「不存在」;其余错误(EACCES / EIO / ENOTDIR …)是读不出,不得折叠成「没变」
      const wantUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const fileIdent = async (p: string): Promise<Ident | null | 'error' | 'unsafe'> => {
        try {
          const s = await lstat(p);
          if (recheckUnsafe(s, wantUid, JUDGE_SOURCE_MAX_BYTES) !== null) return 'unsafe';
          return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'error';
        }
      };
      const propNow = await fileIdent(propFile);
      if (propNow === 'error') return bad('recheck_io');
      if (propNow === 'unsafe') return bad('recheck_unsafe');
      if (!fileSame(propIdent, propNow)) return racy();
      if (target !== null && dRules !== null && dRules.kind === 'ok') {
        const ruleNow = await fileIdent(path.join(rulesDir, `${target}.md`));
        if (ruleNow === 'error') return bad('recheck_io');
        if (ruleNow === 'unsafe') return bad('recheck_unsafe');
        if (!fileSame(ruleIdent, ruleNow)) return racy();
      }
      const second = await attribute();
      if (second !== 'consumable') return second === 'excluded' ? racy() : second;
      if (aborted()) return bad('timeout');

      return fail ?? { kind: 'ok', proposal: value, rule };
    },
  };
}

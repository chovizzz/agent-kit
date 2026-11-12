/**
 * `canary-admission.json` 的**唯一写入方**(docs/contracts.md §21.24 W0-3;worker 持 `rsi/lock` 与 `personal/lock`,0600)。
 * 判定在 `admission-plan.ts`(纯函数);本文件只做:读现有文件 → 交给判定 → 有变化才原子写。
 *
 * 现有文件读不到 / 不合规(`unreadable`):**不覆盖、不重探**,返回 `blocked`(fail-closed:一个损坏的准入文件不该被静默替换成「重新开始」——
 * hint 对它的解释是 `permit_unreadable`,也就是不授予);修复(删除坏文件)是人的动作。文件不存在 = 没有任何 agent 条目。
 * 本函数不决定是否「应该运行」(自动循环有效等条件在 `AdmissionPlanInput` 里传入判定)。
 */
import { canonicalJson } from '../../io/canonical-json.js';
import { CanaryAdmissionSchema } from '../../contracts/rsi-personal.js';
import type { IoContext } from '../../io/paths.js';
import { writeRsiFileAtomic, type HeldLock } from './atomic-write.js';
import { planAdmission, type AdmissionChange, type AdmissionPlanInput } from './admission-plan.js';
import { CANARY_FILES } from './files.js';
import { readAdmissionDoc } from './permit-read.js';

export interface AdmissionWriterDeps {
  io: IoContext;
  rsiDir: string;
  locks: { rsi: HeldLock; personal: HeldLock };
}

export type AdmissionStep =
  | { kind: 'unchanged' }
  | { kind: 'written'; changes: AdmissionChange[] }
  | { kind: 'blocked'; why: 'admission_file_unreadable' };

/** 除 `current`(本函数自己读)之外的判定输入 */
export type AdmissionInputs = Omit<AdmissionPlanInput, 'current'>;

export async function stepAdmission(
  d: AdmissionWriterDeps,
  inputs: AdmissionInputs,
): Promise<AdmissionStep> {
  await d.locks.rsi.assertHeld();
  await d.locks.personal.assertHeld();
  const cur = await readAdmissionDoc(d.rsiDir);
  if (cur.kind === 'unreadable') return { kind: 'blocked', why: 'admission_file_unreadable' };
  const plan = planAdmission({ ...inputs, current: cur.kind === 'ok' ? cur.value : null });
  if (!plan.changed) return { kind: 'unchanged' };
  const doc = CanaryAdmissionSchema.parse(plan.next);
  await writeRsiFileAtomic(d.io, d.rsiDir, CANARY_FILES.admission, canonicalJson(doc), [
    d.locks.rsi,
    d.locks.personal,
  ]);
  return { kind: 'written', changes: plan.changes };
}

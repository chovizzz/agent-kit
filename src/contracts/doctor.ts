import { z } from 'zod';

/**
 * S0 追加(docs/contracts.md §19.3):doctor 的检查 id 与结果枚举。编号只追加不重排。
 * D13(hook)恒为 n_a(套件目前不渲染 hook);D16 记录最近一次自动同步。
 */
export const DOCTOR_CHECK_IDS = [
  'D01',
  'D02',
  'D03',
  'D04',
  'D05',
  'D06',
  'D07',
  'D08',
  'D09',
  'D10',
  'D11',
  'D12',
  'D13',
  'D14',
  'D15',
  'D16',
] as const;
export const DoctorCheckIdSchema = z.enum(DOCTOR_CHECK_IDS);
export type DoctorCheckId = z.infer<typeof DoctorCheckIdSchema>;

export const DOCTOR_STATUSES = ['ok', 'warn', 'fail', 'n_a'] as const;
export const DoctorStatusSchema = z.enum(DOCTOR_STATUSES);

export const DOCTOR_USAGE_REASONS = ['unknown_arg', 'bad_check_id', 'home_not_allowed'] as const;
export const DOCTOR_FAIL_CLOSED_REASONS = [
  'state_unreadable',
  'state_dir_unsafe',
  'output_leak',
] as const;
export const DOCTOR_NOT_RUN_REASONS = ['network_unavailable'] as const;

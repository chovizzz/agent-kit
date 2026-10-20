/**
 * `agent-kit calibrate [--vendor <v>] [--json]`(K5b,judge 校准账的只读报告,口径见 docs/contracts.md §18.10)。
 *
 * 读**基线(HEAD)树**里已冻结的预测,复用 K5a 的 `computeCalibration`(不复制口径,不新增任何阈值),把每个 judge 键
 * (vendor、vendor/model 两档)的 n / 命中 / 平均置信度 / gap / 状态,以及未结算、损坏、不可测等计数摆出来,并**固定披露**这份账的盲区
 * (只算已结算样本、覆盖率、被删提案不在账里、低置信度稀释未检查、浅克隆会 UNAVAILABLE 等)。它是给维护者看的报告,**不是某次晋升的预演**:
 * G3 T2 会排除正在被判的提案,本命令不排除任何提案。
 *
 * - **纯本地、零网络、零写入**:不 import llm-exec / backends;不写任何文件;`--run-llm` / `--allow-egress` 出现即退出 2。
 * - 只读 HEAD:工作树里改过 / 删掉的 `kit.toml`、提案、attest 不影响结果。
 * - `--vendor <v>` 只过滤**显示**的 vendor 行(按 `calibrationKeys` 归一化);盲区行、全局计数、被隐藏 vendor 的 overconfident / 损坏 / 加严计数
 *   与退出码都不受过滤影响,被隐藏的部分在 `hidden_*` 里披露。
 * - 退出码:0 完成(即使有 overconfident / 损坏条目——它们只是被报告,是否加严是 G3 的事);2 用法(未知参数、缺值、`--run-llm` /
 *   `--allow-egress`);3 fail-closed(git 不可用、HEAD 解析不了、`kit.toml` 读不出、任一 vendor 的 `computeCalibration` 返回
 *   `unavailable` → `CALIBRATION_UNAVAILABLE`,此时 stdout 只有 `ok=false`,不输出任何残缺的档位)。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON,全部整数,不含浮点);stderr 只含稳定码 `CALIBRATE_* reason=<码>`。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { LifecycleCoreConfigSchema } from '../contracts/config.js';
import { canonicalJson } from '../io/canonical-json.js';
import { createGuardGit, GitError } from '../guards/git.js';
import type { GuardGit } from '../guards/types.js';
import {
  calibrationKeys,
  calibrationStrictReasons,
  computeCalibration,
  type CalibrationEnv,
  type CalibrationOutcome,
  type KeyStat,
} from '../lifecycle/calibration.js';
import { loadConfig } from '../lifecycle/promote-rule.js';
import { PromoteError } from '../lifecycle/promote-rule.js';
import type { CommandContext, CommandDef } from './types.js';

export interface CalibrateCommandDeps {
  /** 测试注入;缺省 = 以仓库根为 cwd 的只读 git(`createGuardGit`) */
  git?: GuardGit;
  /** 测试注入:传给 git 子进程的额外环境 */
  gitEnv?: Readonly<Record<string, string>>;
}

interface Parsed {
  vendor: string | undefined;
  json: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { vendor: undefined, json: false, error: undefined };
  const fail = (m: string): void => {
    out.error ??= m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') {
      out.json = true;
    } else if (
      a === '--run-llm' ||
      a === '--allow-egress' ||
      a.startsWith('--run-llm=') ||
      a.startsWith('--allow-egress=')
    ) {
      fail('no_egress_flags');
    } else if (a === '--vendor') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('needs_value:--vendor');
      else {
        i++;
        out.vendor = v;
      }
    } else if (a.startsWith('--vendor=')) {
      out.vendor = a.slice('--vendor='.length);
    } else fail('unknown_arg');
  }
  if (out.error === undefined && out.vendor !== undefined && out.vendor.trim() === '')
    out.error = 'bad_vendor';
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'FAIL_CLOSED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** 披露用的固定盲区 id(顺序固定;文本里逐行输出,JSON 里是数组) */
export const BLIND_SPOTS = [
  'selection_bias_settled_only',
  'coverage_settled_over_frozen',
  'deleted_proposals_not_in_ledger',
  'dilution_not_checked',
  'time_boundary_committer_date',
  'attest_member_self_reported',
  'shallow_clone_or_root_commit_unavailable',
  'not_a_promotion_preview',
] as const;

interface TierRow {
  key: string;
  n: number;
  hits: number;
  sum_conf10: number;
  /** 平均置信度 ×1000(四舍五入);n=0 为 null */
  mean_conf_permille: number | null;
  hit_permille: number | null;
  /** (Σconf10 − 10·hits)·100/n 四舍五入;只用于显示,状态一律取自 judgeKeyStat */
  gap_permille: number | null;
  status: 'insufficient' | 'overconfident' | 'ok';
}

function tierRow(t: KeyStat): TierRow {
  const status = t.overconfident ? 'overconfident' : t.insufficient ? 'insufficient' : 'ok';
  const per = (num: number): number | null => (t.n === 0 ? null : Math.round(num / t.n));
  return {
    key: t.key,
    n: t.n,
    hits: t.hits,
    sum_conf10: t.sumConf10,
    mean_conf_permille: per(t.sumConf10 * 100),
    hit_permille: per(t.hits * 1000),
    gap_permille: per((t.sumConf10 - 10 * t.hits) * 100),
    status,
  };
}

interface VendorRow {
  vendor: string;
  frozen: number;
  settled: number;
  coverage_permille: number | null;
  unsettled: number;
  baseline_insufficient: number;
  not_measurable: number;
  ignored_superseded: number;
  superseded_counted_miss: number;
  unreadable_items: number;
  unreadable_files: string[];
  settled_conf_05: number;
  settled_conf_07: number;
  settled_conf_09: number;
  g3_strict: 'yes' | 'no';
  g3_strict_reasons: string[];
  tiers: TierRow[];
}

/**
 * `outs` = 该 vendor 下每个 (vendor, model) 各一次的计算结果。vendor 级数据(档、unsettled、unreadable、counts)每次都相同,取第一份;
 * 加严原因取**并集**:T2 判某个提案时用的是「vendor 档 + 该 judge 自己的 model 档」,所以这家 vendor 下任一 model 作为被判 judge 会不会加严,
 * 要看每个 model 那次调用的结果,不能只看第一个。
 */
function vendorRow(
  vendor: string,
  outs: readonly CalibrationOutcome[],
  tiers: TierRow[],
): VendorRow {
  const o = outs[0]!;
  const settled = tiers.find((t) => t.key === vendor)?.n ?? 0;
  const reasons = (['unavailable', 'unreadable', 'overconfident'] as const).filter((r) =>
    outs.some((x) => calibrationStrictReasons(x).includes(r)),
  );
  return {
    vendor,
    frozen: o.counts.entries,
    settled,
    coverage_permille:
      o.counts.entries === 0 ? null : Math.floor((settled * 1000) / o.counts.entries),
    unsettled: o.unsettled,
    baseline_insufficient: o.counts.baselineInsufficient,
    not_measurable: o.counts.notMeasurable,
    ignored_superseded: o.counts.ignoredSuperseded,
    superseded_counted_miss: o.counts.supersededMiss,
    unreadable_items: o.unreadable.length,
    unreadable_files: [...new Set(o.unreadable.map((u) => u.path))].sort(),
    settled_conf_05: o.counts.conf10['5'] ?? 0,
    settled_conf_07: o.counts.conf10['7'] ?? 0,
    settled_conf_09: o.counts.conf10['9'] ?? 0,
    g3_strict: reasons.length > 0 ? 'yes' : 'no',
    g3_strict_reasons: reasons,
    tiers,
  };
}

const show = (v: unknown): string => (v === null ? '-' : String(v));

function textOf(report: Record<string, unknown>, rows: readonly VendorRow[]): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(report)) {
    if (k === 'vendors' || k === 'blind_spots') continue;
    lines.push(`${k}=${show(v)}`);
  }
  for (const r of rows) {
    const { tiers, unreadable_files, g3_strict_reasons, ...flat } = r;
    for (const [k, v] of Object.entries(flat)) lines.push(`vendor.${r.vendor}.${k}=${show(v)}`);
    lines.push(`vendor.${r.vendor}.g3_strict_reasons=${g3_strict_reasons.join(',') || '-'}`);
    for (const f of unreadable_files) lines.push(`vendor.${r.vendor}.unreadable_file=${f}`);
    for (const t of tiers) {
      const { key, ...rest } = t;
      lines.push(
        `tier ${key} ${Object.entries(rest)
          .map(([k, v]) => `${k}=${show(v)}`)
          .join(' ')}`,
      );
    }
  }
  for (const b of BLIND_SPOTS) lines.push(`blind_spot=${b}`);
  return `${lines.join('\n')}\n`;
}

export function createCalibrateCommand(deps: CalibrateCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'calibrate',
    summary: '只读报告 judge 校准账(各键 n/命中/gap/状态 + 盲区披露),不写任何文件',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      {
        name: '--vendor <v>',
        description: '只显示该 vendor 的行(盲区与全局计数不变,被隐藏部分在 hidden_* 里披露)',
      },
      { name: '--json', description: 'stdout 输出 canonical JSON' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        const io = ctx.io;
        // 只读命令不许因缺失对象(partial clone)触发 lazy fetch:那既联网又写 .git/objects
        const git =
          deps.git ?? createGuardGit(io, io.repoRoot, { GIT_NO_LAZY_FETCH: '1', ...deps.gitEnv });
        const oid = git.resolveCommit('HEAD');
        if (oid === undefined)
          throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'HEAD_UNRESOLVED');
        let config;
        try {
          config = loadConfig(git, oid);
        } catch (e) {
          if (e instanceof PromoteError)
            throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.reason);
          throw e;
        }
        const roster = new Map<string, string | undefined>();
        for (const [h, m] of Object.entries(config.channels.canary.members))
          roster.set(h.toLowerCase(), m.since);
        const base: Omit<CalibrationEnv, 'target'> = {
          git,
          baseOid: oid,
          baseView: (p) => git.textAt(oid, p),
          listBase: (d) => git.listFiles(oid, d),
          cfg: config.lifecycle ?? LifecycleCoreConfigSchema.parse({}),
          roster,
          // 不匹配任何提案文件名:本命令不排除任何提案
          excludeProposalId: '',
        };
        const failClosed = (): never => {
          const report = { ok: false, reason: 'CALIBRATION_UNAVAILABLE', base_oid: oid };
          ctx.stdout(args.json ? canonicalJson(report) : textOf(report, []));
          throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'CALIBRATION_UNAVAILABLE');
        };

        // 枚举调用:空 target 不匹配任何 vendor,只做枚举与前置检查(提案历史解析、浅克隆检测等);
        // 之后每个 (vendor, model) 的调用都参与 fail-closed 汇总,不论该 vendor 是否被 --vendor 隐藏
        const probe = computeCalibration({ ...base, target: { vendor: '', model: '' } });
        if (probe.unavailable !== undefined) failClosed();

        const byVendor = new Map<
          string,
          { outs: CalibrationOutcome[]; tiers: Map<string, TierRow> }
        >();
        for (const k of probe.seen) {
          const o = computeCalibration({ ...base, target: { vendor: k.vendor, model: k.model } });
          if (o.unavailable !== undefined) failClosed();
          const { vendorKey, modelKey } = calibrationKeys(k.vendor, k.model);
          const slot = byVendor.get(vendorKey) ?? { outs: [], tiers: new Map<string, TierRow>() };
          slot.outs.push(o);
          // vendor 级数据(档、unsettled、unreadable、counts)是整家 vendor 的,同 vendor 各次调用相同,只取第一次;
          // model 档每个 model 取自己那次调用
          for (const t of o.tiers) {
            if (t.key === vendorKey || t.key === modelKey) slot.tiers.set(t.key, tierRow(t));
          }
          byVendor.set(vendorKey, slot);
        }
        const all: VendorRow[] = [...byVendor.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([vendor, slot]) =>
            vendorRow(
              vendor,
              slot.outs,
              [...slot.tiers.values()].sort((a, b) =>
                a.key === vendor ? -1 : b.key === vendor ? 1 : a.key < b.key ? -1 : 1,
              ),
            ),
          );
        const filter =
          args.vendor === undefined ? undefined : calibrationKeys(args.vendor, '').vendorKey;
        const shown = filter === undefined ? all : all.filter((r) => r.vendor === filter);
        const hidden = all.filter((r) => !shown.includes(r));
        const sum = (f: (r: VendorRow) => number): number => all.reduce((s, r) => s + f(r), 0);
        const frozen = sum((r) => r.frozen);
        const settled = sum((r) => r.settled);
        const report = {
          ok: true,
          base_oid: oid,
          filter: filter ?? null,
          vendors_total: all.length,
          vendors_shown: shown.length,
          frozen_total: frozen,
          settled_total: settled,
          coverage_permille: frozen === 0 ? null : Math.floor((settled * 1000) / frozen),
          unsettled_total: sum((r) => r.unsettled),
          hidden_vendors: hidden.length,
          hidden_overconfident: hidden.reduce(
            (s, r) => s + r.tiers.filter((t) => t.status === 'overconfident').length,
            0,
          ),
          hidden_unreadable_items: hidden.reduce((s, r) => s + r.unreadable_items, 0),
          hidden_g3_strict: hidden.filter((r) => r.g3_strict === 'yes').length,
          vendors: shown,
          blind_spots: [...BLIND_SPOTS],
        };
        ctx.stdout(args.json ? canonicalJson(report) : textOf(report, shown));
        return ExitCode.OK;
      } catch (e) {
        let x: Exit;
        if (e instanceof Exit) x = e;
        else if (e instanceof GitError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'git_failed');
        else x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'internal');
        ctx.stderr(`CALIBRATE_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };
  return def;
}

export const command: CommandDef = createCalibrateCommand();

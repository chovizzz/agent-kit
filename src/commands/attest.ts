/**
 * `agent-kit attest --rule <id> --member @handle (--window-start D --window-end D | --tile <k>)
 *   [--channel canary|stable] [--agent <id>]… [--write] [--json]`(L5,docs/contracts.md §18):
 * 在本机把窗口内的信号数成一份证据摘要(`Attest`,口径 `signature_proxy_v1`),并生成只新增
 * `attest/<rule-id>/<member>-<window_end>-<run_id>.json` 的补丁 `attest.patch`。
 *
 * - `--tile <k> --freeze-date D`(K4):读**工作树**提案里冻结的验收协议,按与 G3 同一组函数(`acceptanceD0`/`tileWindow`)算第 k 块窗口,
 *   并把冻结协议的 `sha256` 写进 attest 的 `acceptance_sha256`;手填窗口时若工作树提案有匹配的冻结协议也会绑定。
 *   **不读 git**(A22:本命令闭包不含 child_process),冻结提交日期由 `--freeze-date` 给;给错只会产生 G3 判为不计入的窗口。
 *   读不到冻结协议:--tile 退出 1/3,手填窗口则不写该字段(这样的 attest 不会被 G3 计入)。
 * - **纯本地、零网络**:不 import llm-exec 或任何后端;`--run-llm` / `--allow-egress` 出现即退出 2。
 * - **默认干跑**:只算、只打印;`--write` 才写,且只写 `.state/attest/<run_id>/`(attest.patch + report.json),
 *   一律经 safe-fs(写出口守卫);不写 `attest/`、不写 `rules/`——落到仓库靠人 `git apply` + `kit:attest` PR。
 * - 幂等:run_id 由(可注入的)时钟与随机源决定;同 run_id 目录已存在且内容一致 → 退出 0 不重写,不一致 → 退出 3。
 * - 退出码:0 干跑完成 / 已写出;1 规则不可计数(状态不是 advisory/active、无签名、签名不安全);
 *   2 用法(缺参数、member 不在成员表、窗口反了、规则不存在、personal 层、`--run-llm`);
 *   3 fail-closed(信号库损坏、配置读取失败、写出口拒绝、同 run_id 不一致、补丁自检不过);
 *   4 未执行(窗口内没有任何信号/会话数据、`signature.type=path` 无数据源)。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码 `ATTEST_* reason=<码>`。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseAtom } from '../atoms/parse.js';
import { loadKitConfig } from '../build/config.js';
import { AttestSchema, attestFileName } from '../contracts/attest.js';
import type { Attest } from '../contracts/attest.js';
import type { AcceptanceProtocol } from '../contracts/proposal.js';
import type { Atom } from '../contracts/atom.js';
import { AgentIdSchema, IsoDateSchema } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import { ChannelNameSchema, OverlaySchema } from '../contracts/config.js';
import { AcceptanceProtocolSchema } from '../contracts/proposal.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { canonicalJson } from '../io/canonical-json.js';
import { acceptanceSha256 } from '../judge/freeze.js';
import type { IoContext } from '../io/paths.js';
import { exists, lstat, readDir, readText } from '../io/read-fs.js';
import { chmod, mkdirp, rename, writeFile, WriteDeniedError } from '../io/safe-fs.js';
import { checkAttestScope } from '../guards/attest.js';
import type { Change } from '../guards/types.js';
import {
  acceptanceD0,
  buildMatcher,
  buildNewFilePatch,
  countWindow,
  loadWindowData,
  normalizedRuleSha256,
  proposalPathOfOrigin,
  signalIdsDigest,
  tileWindow,
  windowBounds,
} from '../lifecycle/attest-count.js';
import { gitBlobOid, patchUnsafe } from '../reflect/stage.js';
import { SignalStoreError } from '../signals/state-store.js';
import type { CommandContext, CommandDef } from './types.js';

export interface AttestCommandDeps {
  /** 时钟(run_id 的时间戳);缺省取系统时间 */
  now?(): Date;
  /** 随机源:返回 n 字节的十六进制串(run_id 后缀);缺省 node:crypto */
  randomHex?(bytes: number): string;
}

interface Parsed {
  rule: string | undefined;
  member: string | undefined;
  windowStart: string | undefined;
  windowEnd: string | undefined;
  tile: number | undefined;
  freezeDate: string | undefined;
  channel: string | undefined;
  agents: AgentId[];
  write: boolean;
  json: boolean;
  error: string | undefined;
}

const MEMBER_RE = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ZERO_OID = '0'.repeat(40);

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    rule: undefined,
    member: undefined,
    windowStart: undefined,
    windowEnd: undefined,
    tile: undefined,
    freezeDate: undefined,
    channel: undefined,
    agents: [],
    write: false,
    json: false,
    error: undefined,
  };
  const fail = (m: string): void => {
    out.error ??= m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail(`needs_value:${name}`);
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--write') {
      out.write = true;
      continue;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--run-llm' || a === '--allow-egress' || a.startsWith('--run-llm=')) {
      fail('no_egress_flags');
      continue;
    }
    const rule = value('--rule');
    if (rule !== undefined) {
      out.rule = rule;
      continue;
    }
    const member = value('--member');
    if (member !== undefined) {
      out.member = member;
      continue;
    }
    const ws = value('--window-start');
    if (ws !== undefined) {
      out.windowStart = ws;
      continue;
    }
    const we = value('--window-end');
    if (we !== undefined) {
      out.windowEnd = we;
      continue;
    }
    const tile = value('--tile');
    if (tile !== undefined) {
      if (/^\d{1,3}$/.test(tile)) out.tile = Number(tile);
      else fail('bad_tile');
      continue;
    }
    const fd = value('--freeze-date');
    if (fd !== undefined) {
      if (IsoDateSchema.safeParse(fd).success) out.freezeDate = fd;
      else fail('bad_freeze_date');
      continue;
    }
    const ch = value('--channel');
    if (ch !== undefined) {
      out.channel = ch;
      continue;
    }
    const ag = value('--agent');
    if (ag !== undefined) {
      const p = AgentIdSchema.safeParse(ag);
      if (!p.success) fail('bad_agent');
      else if (!out.agents.includes(p.data)) out.agents.push(p.data);
      continue;
    }
    fail('unknown_arg');
  }
  if (out.error === undefined) {
    if (out.rule === undefined) out.error = 'missing:--rule';
    else if (out.member === undefined) out.error = 'missing:--member';
    else if (
      out.tile !== undefined &&
      (out.windowStart !== undefined || out.windowEnd !== undefined)
    )
      out.error = 'tile_conflicts_window';
    else if (out.tile !== undefined && out.freezeDate === undefined)
      out.error = 'missing:--freeze-date';
    else if (out.tile === undefined && out.freezeDate !== undefined)
      out.error = 'freeze_date_needs_tile';
    else if (out.tile === undefined && out.windowStart === undefined)
      out.error = 'missing:--window-start';
    else if (out.tile === undefined && out.windowEnd === undefined)
      out.error = 'missing:--window-end';
    else if (!MEMBER_RE.test(out.member)) out.error = 'bad_member';
    else if (out.windowStart !== undefined && !IsoDateSchema.safeParse(out.windowStart).success)
      out.error = 'bad_window_start';
    else if (out.windowEnd !== undefined && !IsoDateSchema.safeParse(out.windowEnd).success)
      out.error = 'bad_window_end';
    else if (
      out.windowStart !== undefined &&
      out.windowEnd !== undefined &&
      out.windowEnd < out.windowStart
    )
      out.error = 'window_reversed';
    else if (out.channel !== undefined && !ChannelNameSchema.safeParse(out.channel).success)
      out.error = 'bad_channel';
  }
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

function newRunId(now: Date, rnd: (bytes: number) => string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `run-${stamp}-${rnd(3)}`;
}

/** 覆盖层只读 `channel`;失败不回显内容。 */
async function overlayChannel(ctx: CommandContext): Promise<string | undefined> {
  if (ctx.overlayPath === undefined) return undefined;
  try {
    const overlay = OverlaySchema.parse(parseToml(await readText(ctx.overlayPath)));
    return overlay.channel;
  } catch {
    throw new Exit(ExitCode.USAGE, 'USAGE', 'overlay_unreadable');
  }
}

async function findAtom(
  io: IoContext,
  id: string,
): Promise<{ atom: Atom; source: string } | undefined> {
  const root = path.join(io.repoRoot, 'rules');
  if (!(await exists(root))) return undefined;
  const dirs = (await readDir(root)).filter((d) => d.isDirectory && !d.name.startsWith('.'));
  for (const d of dirs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = path.join(root, d.name);
    for (const f of (await readDir(dir)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!f.isFile || !f.name.endsWith('.md')) continue;
      const source = await readText(path.join(dir, f.name));
      const res = parseAtom(source, `rules/${d.name}/${f.name}`);
      if (res.atom?.fm.id === id) return { atom: res.atom, source };
    }
  }
  return undefined;
}

function expandApplies(atom: Atom): AgentId[] {
  const a = atom.fm.applies_to;
  if (a === undefined || a.includes('all')) return [];
  return a.filter((x): x is AgentId => x !== 'all');
}

/** 目录必须是真实目录(不是符号链接);不存在则放过。 */
async function assertRealDir(dir: string): Promise<void> {
  if (!(await exists(dir))) return;
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_dir_unsafe');
  }
}

/** 文件必须是单链接的普通文件。 */
async function assertRegularFile(file: string): Promise<void> {
  const st = await lstat(file);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_file_unsafe');
  }
}

async function put(io: IoContext, file: string, content: string): Promise<void> {
  await mkdirp(io, path.dirname(file), 0o700);
  await chmod(io, path.dirname(file), 0o700);
  await writeFile(io, file, content, { mode: 0o600 });
  await chmod(io, file, 0o600);
}

/**
 * 工作树提案里的冻结协议。本命令的 import 闭包不得含 child_process(A22:零网络、不起子进程),所以**不读 git**:
 * 冻结提交的日期由调用方经 `--freeze-date` 给(`git log -1 --format=%cs -- proposals/<id>.yaml`,须是 `judge.acceptance`
 * 首次入库的那次提交)。给错了只会算出 G3 判为不对齐的窗口(不计入),不会放宽任何判据——权威是 G3 对 git 的复核。
 */
interface FrozenProtocol {
  acc: AcceptanceProtocol;
}
async function readFrozenProtocol(
  io: IoContext,
  origin: unknown,
  ruleSha: string | undefined,
): Promise<{ ok: true; frozen: FrozenProtocol } | { ok: false; reason: string }> {
  const pp = proposalPathOfOrigin(origin);
  if (pp === undefined) return { ok: false, reason: 'no_proposal' };
  const file = path.join(io.repoRoot, pp);
  if (!(await exists(file))) return { ok: false, reason: 'no_proposal' };
  const y = parseRestrictedYaml(await readText(file), pp, 'GUARD_PROPOSAL_YAML');
  const judge =
    y.ok && typeof y.value === 'object' && y.value !== null
      ? (y.value as { judge?: unknown }).judge
      : undefined;
  const rawAcc =
    typeof judge === 'object' && judge !== null
      ? (judge as { acceptance?: unknown }).acceptance
      : undefined;
  if (rawAcc === undefined) return { ok: false, reason: 'acceptance_missing' };
  const parsed = AcceptanceProtocolSchema.safeParse(rawAcc);
  if (!parsed.success || acceptanceSha256(parsed.data) !== parsed.data.sha256) {
    return { ok: false, reason: 'acceptance_invalid' };
  }
  if (ruleSha === undefined || parsed.data.rule_sha256 !== ruleSha) {
    return { ok: false, reason: 'acceptance_stale' };
  }
  return { ok: true, frozen: { acc: parsed.data } };
}

export function createAttestCommand(deps: AttestCommandDeps = {}): CommandDef {
  const now = deps.now ?? ((): Date => new Date());
  const rnd = deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex'));

  async function execute(ctx: CommandContext, args: Parsed): Promise<number> {
    const rule = args.rule as string;
    const member = args.member as string;
    const io = ctx.io;

    const loaded = loadKitConfig(io.repoRoot);
    if (loaded.config === undefined) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'config');
    const config = loaded.config;

    const channelRaw = args.channel ?? (await overlayChannel(ctx)) ?? 'canary';
    const channel = ChannelNameSchema.parse(channelRaw);
    const members = (config.channels as Record<string, { members: Record<string, unknown> }>)[
      channel
    ]?.members;
    if (members === undefined || !(member in members)) {
      throw new Exit(ExitCode.USAGE, 'USAGE', 'member_not_in_channel');
    }

    const found = await findAtom(io, rule);
    if (found === undefined) throw new Exit(ExitCode.USAGE, 'USAGE', 'rule_not_found');
    const { atom, source } = found;
    if (atom.fm.layer === 'personal') {
      throw new Exit(ExitCode.USAGE, 'USAGE', 'PERSONAL_LAYER_P2');
    }
    if (atom.fm.status !== 'advisory' && atom.fm.status !== 'active') {
      throw new Exit(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'rule_not_countable');
    }

    const matcher = buildMatcher(atom.fm.signature);
    if (matcher.kind === 'none')
      throw new Exit(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'signature_missing');
    if (matcher.kind === 'unsafe')
      throw new Exit(ExitCode.CHECK_FAILED, 'CHECK_FAILED', 'signature_unsafe');
    if (matcher.kind === 'path')
      throw new Exit(ExitCode.NOT_RUN, 'NOT_RUN', 'signature_path_unsupported');

    // K4:冻结协议(读工作树提案,不起子进程)。--tile 必须读到;手填窗口时尽力绑定,读不到就不写 acceptance_sha256(这样的 attest 不会被 G3 计入)
    const ruleSha = normalizedRuleSha256(source);
    const fr = await readFrozenProtocol(io, atom.fm.origin, ruleSha);
    let windowStart = args.windowStart as string;
    let windowEnd = args.windowEnd as string;
    if (args.tile !== undefined) {
      if (!fr.ok) {
        if (fr.reason === 'acceptance_missing' || fr.reason === 'acceptance_stale') {
          throw new Exit(ExitCode.CHECK_FAILED, 'CHECK_FAILED', fr.reason);
        }
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', fr.reason);
      }
      if (args.tile >= fr.frozen.acc.max_tiles) {
        throw new Exit(ExitCode.USAGE, 'USAGE', 'tile_out_of_range');
      }
      const d0 = acceptanceD0(fr.frozen.acc, args.freezeDate as string);
      const w = tileWindow(d0, fr.frozen.acc.tile_days, args.tile);
      windowStart = w.start;
      windowEnd = w.end;
      // 分块还没结束就出 attest 会把不完整的窗口记成「已覆盖」
      if (windowEnd >= now().toISOString().slice(0, 10)) {
        throw new Exit(ExitCode.NOT_RUN, 'NOT_RUN', 'tile_not_ended');
      }
    }
    const acceptanceBind = fr.ok ? fr.frozen.acc.sha256 : undefined;

    const runId = newRunId(now(), rnd);
    const attestPath = `attest/${rule}/${attestFileName({ member, window_end: windowEnd, run_id: runId })}`;

    const agents = args.agents.length > 0 ? args.agents : expandApplies(atom);
    const { fromMs, toMs } = windowBounds(windowStart, windowEnd);
    const data = await loadWindowData(io, fromMs, toMs, agents);
    // 窗口内的坏行会让 harmful 等计数偏低:按库损坏处理,不出报告
    if (data.droppedSchema > 0)
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'signal_store_schema');
    const counted = countWindow({
      signals: data.signals,
      sessionStats: data.sessionStats,
      matcher,
      from: fromMs,
      to: toMs,
      agents,
    });
    if (counted.window_signals === 0 && counted.window_stat_rows === 0) {
      throw new Exit(ExitCode.NOT_RUN, 'NOT_RUN', 'no_window_data');
    }

    const attest: Attest = AttestSchema.parse({
      schema_version: 1,
      rule_id: rule,
      rule_sha256: ruleSha,
      channel,
      member,
      window_start: windowStart,
      window_end: windowEnd,
      kit_version: KIT_VERSION,
      collector_versions: counted.collector_versions,
      sessions_total: counted.sessions_total,
      exposure_sessions: counted.exposure_sessions,
      exposure_projects: counted.exposure_projects,
      fired: counted.fired,
      harmful: counted.harmful,
      recurrence: counted.recurrence,
      signal_ids_digest: signalIdsDigest(counted.signal_ids),
      method: 'signature_proxy_v1',
      ...(acceptanceBind !== undefined ? { acceptance_sha256: acceptanceBind } : {}),
      run_id: runId,
    } satisfies Attest);

    const fileContent = canonicalJson(attest);
    const unsafe = patchUnsafe(fileContent);
    if (unsafe !== undefined) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'patch_unsafe');
    const patch = buildNewFilePatch(attestPath, fileContent);
    // 自检:补丁只新增 attest/** 普通文件(与 CI 的 kit:attest 守卫同一函数)
    const change: Change = {
      kind: 'A',
      path: attestPath,
      baseMode: '000000',
      headMode: '100644',
      baseOid: ZERO_OID,
      headOid: gitBlobOid(fileContent),
    };
    if (checkAttestScope([change]).length > 0) {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'patch_scope');
    }

    const summary = {
      run_id: runId,
      dry: !args.write,
      rule_id: rule,
      member,
      channel,
      window_start: windowStart,
      window_end: windowEnd,
      method: 'signature_proxy_v1',
      ...(args.tile !== undefined ? { tile: args.tile } : {}),
      ...(acceptanceBind !== undefined ? { acceptance_sha256: acceptanceBind } : {}),
      sessions_total: attest.sessions_total,
      exposure_sessions: attest.exposure_sessions,
      exposure_projects: attest.exposure_projects,
      fired: attest.fired,
      harmful: attest.harmful,
      recurrence: attest.recurrence,
      deduplicated: counted.deduplicated,
      rule_sha256: attest.rule_sha256,
      signal_ids_digest: attest.signal_ids_digest,
      attest_path: attestPath,
      patch_sha256: createHash('sha256').update(patch).digest('hex'),
    };
    const report = canonicalJson({ ...summary, dry: false });

    let wrote = false;
    let existing = false;
    if (args.write) {
      const dir = path.join(io.stateDir, 'attest', runId);
      await assertRealDir(path.join(io.stateDir, 'attest'));
      if (await exists(dir)) {
        await assertRealDir(dir);
        for (const n of ['attest.patch', 'report.json']) {
          if (await exists(path.join(dir, n))) await assertRegularFile(path.join(dir, n));
        }
        const same =
          (await exists(path.join(dir, 'attest.patch'))) &&
          (await exists(path.join(dir, 'report.json'))) &&
          (await readText(path.join(dir, 'attest.patch'))) === patch &&
          (await readText(path.join(dir, 'report.json'))) === report;
        if (!same) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'run_exists');
        existing = true;
      } else {
        const tmp = path.join(io.stateDir, 'attest', `.tmp-${runId}`);
        if (await exists(tmp)) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'tmp_exists');
        await put(io, path.join(tmp, 'attest.patch'), patch);
        await put(io, path.join(tmp, 'report.json'), report);
        await rename(io, tmp, dir);
        wrote = true;
      }
    }

    const out = { ...summary, wrote, existing };
    if (args.json) ctx.stdout(canonicalJson(out));
    else {
      ctx.stdout(
        `${Object.entries(out)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join('\n')}\n`,
      );
    }
    return ExitCode.OK;
  }

  const def: CommandDef = {
    name: 'attest',
    summary: '生成本机证据摘要(窗口计数 + attest.patch)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--rule <id>', description: '要计数的原子 id(status 须为 advisory/active);必填' },
      { name: '--member <@handle>', description: '成员 handle,须在渠道成员表里;必填' },
      { name: '--window-start <YYYY-MM-DD>', description: '窗口起(UTC,含);不用 --tile 时必填' },
      { name: '--window-end <YYYY-MM-DD>', description: '窗口止(UTC,含);必填' },
      {
        name: '--tile <k>',
        description:
          '按工作树提案里冻结的验收协议算第 k 块(0 起)的窗口并绑定 acceptance_sha256;与 --window-* 互斥,须配 --freeze-date',
      },
      {
        name: '--freeze-date <YYYY-MM-DD>',
        description:
          '冻结提交(judge.acceptance 首次入库的提交)的提交者日期:git log -1 --format=%cs -- proposals/<id>.yaml;仅与 --tile 一起用',
      },
      { name: '--channel <canary|stable>', description: '缺省取覆盖层 channel,再缺省 canary' },
      { name: '--agent <id>', description: '只数该 agent,可重复;缺省按原子 applies_to' },
      {
        name: '--write',
        description: '写 .state/attest/<run_id>/(attest.patch + report.json);缺省只打印',
      },
      { name: '--json', description: 'stdout 输出 canonical JSON' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        return await execute(ctx, args);
      } catch (e) {
        let x: Exit;
        if (e instanceof Exit) x = e;
        else if (e instanceof SignalStoreError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'signal_store');
        else if (e instanceof WriteDeniedError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
        else x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'internal');
        ctx.stderr(`ATTEST_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };
  return def;
}

export const command: CommandDef = createAttestCommand();

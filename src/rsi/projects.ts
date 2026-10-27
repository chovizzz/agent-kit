/**
 * `agent-kit rsi projects [--json | --paths] | --rebuild-index [--write]`(契约 R20-3.5;R20-A2 B3a 实装只读部分)。
 *
 * 只读、不拿锁、不建 `rsi/`:`openRsiIo` → `readRsiState` → `attribute`(现算 P / X / U)→ 行 → 过泄漏闸 → 一次性输出。
 *  - 行按 key 升序;`unknown` 行没有 name、没有 path(N7);目录名经 `cleanName`(控制 / 格式 / 私用 / 未分配码点替换为 `?`,截 64 字节);
 *  - `--paths`:只在 stdout 是 TTY 时允许,与 `--json` 互斥;`path=` 值经 `cleanPath`,是泄漏闸唯一的豁免(由本文件的渲染器以结构给出,
 *    不是从最终文本里推断);`unknown` 行不追加;
 *  - `key8` = `p_` 之后的前 8 位十六进制(「key 前缀」);summary 的 `collecting` 含 `new`(`new` 是采集中的子集,R20-4.2a);
 *  - 首次 `armed`(无索引、无确认)的清单要现算 armed 列举(`l0/armed-listing.ts`:读会话目录与头部,不建盐、不读正文、不写):缺省接 `listArmed`,`deps.listArmed` 可注入;
 *  - `--rebuild-index`(含 `--write`)属 B5:64 命令桩,不读配置。
 * 本文件的 import 闭包不含 safe-fs / lock.ts / snapshot.ts / with-lock.ts / exec.ts。
 */
import * as path from 'node:path';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { parseFlags } from './args.js';
import { attribute, latestRoot, type Attribution, type AttributionProbe } from './attribution.js';
import { buildRsiPolicy, type RsiConfigOn } from './config.js';
import { failExit } from './exit.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import { readRsiState } from './read-state.js';
import { cleanName, cleanPath, type OutLine } from './sanitize.js';
import { listArmed } from './l0/armed-listing.js';
import type { ArmedListing } from './l0/types.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import { loadRepoIdentity, rsiStateOf } from './state.js';
import { rsiStubExit } from './stub.js';
import type { RsiEarlyContext, RsiSubcommand } from './types.js';

// 首次 `armed` 的现算清单:类型在 `l0/types.ts`(B4-0 移入,规划侧模块不得反向依赖本文件),这里 re-export,既有 import 路径不变
export type { ArmedListing };

export interface RsiProjectsDeps {
  /** `--paths` 的 stdout-only TTY 判据(可注入;缺省 `ctx.isTty`,再缺省 `process.stdout.isTTY === true`) */
  stdoutIsTty?: boolean;
  open?: OpenRsiIoDeps;
  probe?: AttributionProbe;
  listArmed?: (io: IoContext, config: RsiConfigOn) => Promise<ArmedListing>;
  /** 只给测试:对渲染好的行做一次篡改(演练泄漏闸) */
  tamper?: (lines: OutLine[]) => OutLine[];
}

type RowStatus = 'collecting' | 'excluded' | 'purge_pending' | 'new' | 'unknown' | 'pending';

interface Row {
  key8: string | null;
  name: string | null;
  sessions: number;
  signals: number | null;
  status: RowStatus;
  path: string | null;
}

interface Summary {
  collecting: number;
  excluded: number;
  new: number;
  unknown_signals: number;
  unknown_sessions: number;
}

const cmpKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function textLines(
  rows: readonly Row[],
  s: Summary,
  paths: boolean,
  firstArmed: boolean,
  incomplete = false,
): OutLine[] {
  const out: OutLine[] = [];
  for (const r of rows) {
    let head: string;
    if (r.status === 'unknown') {
      head = `key=${r.key8 ?? '-'} sessions=${r.sessions} signals=${r.signals ?? 0} status=unknown`;
    } else if (r.status === 'pending' || r.key8 === null) {
      head = `key=- name=${r.name ?? '?'} sessions=${r.sessions} status=${r.status}`;
    } else {
      head = `key=${r.key8} name=${r.name ?? '?'} sessions=${r.sessions} signals=${r.signals ?? 0} status=${r.status}`;
    }
    out.push(
      paths && r.status !== 'unknown' && r.path !== null ? { head, pathValue: r.path } : { head },
    );
  }
  out.push({
    head:
      `projects collecting=${s.collecting} excluded=${s.excluded} new=${s.new} unknown_signals=${s.unknown_signals}` +
      (firstArmed ? ` unknown_sessions=${s.unknown_sessions}` : ''),
  });
  // 首次 armed 的扫描不完整(根不可评估 / 目录读不了 / 触发上限 / 根被换):固定措辞,不带路径;完整时输出不变
  if (incomplete) out.push({ head: 'armed_list=incomplete' });
  return out;
}

const ZERO: Summary = {
  collecting: 0,
  excluded: 0,
  new: 0,
  unknown_signals: 0,
  unknown_sessions: 0,
};

export async function runProjects(
  ctx: RsiEarlyContext,
  deps: RsiProjectsDeps = {},
): Promise<number> {
  const parsed = parseFlags(ctx.argv, ['--json', '--paths', '--rebuild-index', '--write']);
  if (!parsed.ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  const f = parsed.flags;
  const usage = (reason: string): number => {
    ctx.stderr(`RSI_USAGE reason=${reason}\n`);
    return ExitCode.USAGE;
  };
  if (f.has('--write') && !f.has('--rebuild-index')) return usage('write_requires_mode');
  if (f.has('--paths') && (f.has('--json') || f.has('--rebuild-index'))) {
    return usage('mode_conflict');
  }
  if (f.has('--paths') && !(deps.stdoutIsTty ?? ctx.isTty ?? process.stdout.isTTY === true)) {
    return usage('paths_requires_tty'); // R20-3.5.3:只要求 stdout 是 TTY(stdin 可以是 /dev/null)
  }
  if (f.has('--rebuild-index')) return rsiStubExit(ctx, 'projects.rebuild_index'); // B5
  const json = f.has('--json');
  const paths = f.has('--paths');

  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') return usage(open.reason);
    let state = 'off';
    let firstArmed = false;
    let listIncomplete = false;
    let rows: Row[] = [];
    let summary: Summary = { ...ZERO };
    let forbidden: string[];
    if (open.kind === 'off') {
      forbidden = await forbiddenPaths(ctx.env, []);
    } else {
      const { io, config } = open.ctx;
      forbidden = await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]);
      const data = await readRsiState(io);
      const identity = await loadRepoIdentity(config, await buildRsiPolicy(config));
      const st = rsiStateOf({
        config,
        stopPresent: data.stop.present,
        doc: data.stateDoc,
        identity,
      });
      state = st.state;
      firstArmed = st.firstArmed;
      if (st.firstArmed && data.index.status === 'absent') {
        const l = await (
          deps.listArmed ??
          ((i, c) =>
            listArmed(i, c, {
              piDirSet: piDirIsSet(ctx.env),
              ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
            }))
        )(io, config);
        listIncomplete = l.complete === false;
        rows = l.rows
          .map((r): Row => ({
            key8: null,
            name: cleanName(r.name),
            sessions: r.sessions,
            signals: null,
            status: r.excluded ? 'excluded' : 'pending',
            path: cleanPath(r.path),
          }))
          .sort((a, b) => cmpKey(a.name ?? '', b.name ?? ''));
        summary = {
          collecting: rows.filter((r) => r.status === 'pending').length,
          excluded: rows.filter((r) => r.status === 'excluded').length,
          new: 0,
          unknown_signals: 0,
          unknown_sessions: l.unknownSessions,
        };
      } else {
        const ack =
          data.stateDoc.kind === 'ok' || data.stateDoc.kind === 'confirm_schema_invalid'
            ? data.stateDoc.state.projects_ack_generation
            : 0;
        const att = await attribute({
          config,
          indexStatus: data.index.status,
          index: data.index.value,
          counts: data.counts,
          ...(deps.probe !== undefined ? { probe: deps.probe } : {}),
        });
        const entries = data.index.value?.entries ?? [];
        const keyed = new Set(entries.map((e) => e.key));
        const built: { key: string; row: Row }[] = [];
        let uSessions = 0;
        for (const e of entries) {
          const a: Attribution = att.classify(e.key);
          const latest = latestRoot(e.roots);
          // 计数口径:counts.json 存在时它是权威(缺 key = 0 条);只有 counts.json 缺失才回退索引条目的 signals(与 rsi status 一致)
          const signals =
            data.counts === null ? e.signals : (data.counts.per_key[e.key]?.signals_total ?? 0);
          let status: RowStatus;
          if (a === 'P') status = e.first_indexed_generation > ack ? 'new' : 'collecting';
          else if (a === 'X') status = signals > 0 ? 'purge_pending' : 'excluded';
          else status = 'unknown';
          if (a === 'U') {
            uSessions += e.sessions;
          }
          built.push({
            key: e.key,
            row: {
              key8: e.key.slice(2, 10),
              name: status === 'unknown' ? null : cleanName(path.basename(latest.path)),
              sessions: e.sessions,
              signals,
              status,
              path: status === 'unknown' ? null : cleanPath(latest.path),
            },
          });
        }
        built.sort((a, b) => cmpKey(a.key, b.key));
        rows = built.map((b) => b.row);
        // 归入 U 的信号:索引里被判 U 的条目(行上显示的那个数)+ 计数里有、索引里没有的 key + 计数里映射不到 key 的信号
        let unknownSignals = data.counts?.unknown_keys_signals ?? 0;
        for (const b of built)
          if (att.classify(b.key) === 'U') unknownSignals += b.row.signals ?? 0;
        if (data.counts !== null) {
          for (const [k, v] of Object.entries(data.counts.per_key)) {
            if (!keyed.has(k)) {
              unknownSignals += v.signals_total;
              uSessions += v.sessions;
            }
          }
        }
        const collecting = rows.filter((r) => r.status === 'collecting' || r.status === 'new');
        summary = {
          collecting: collecting.length,
          excluded: rows.filter((r) => r.status === 'excluded' || r.status === 'purge_pending')
            .length,
          new: rows.filter((r) => r.status === 'new').length,
          unknown_signals: unknownSignals,
          unknown_sessions: uSessions,
        };
      }
    }
    let lines: OutLine[];
    if (json) {
      lines = jsonLines(
        canonicalJson({
          state,
          first_armed: firstArmed,
          rows: rows.map((r) => ({
            key8: r.key8,
            name: r.name,
            sessions: r.sessions,
            signals: r.signals,
            status: r.status,
          })),
          summary,
          ...(listIncomplete ? { complete: false } : {}),
        }),
      );
    } else {
      lines = textLines(
        rows,
        summary,
        paths,
        firstArmed && rows.every((r) => r.key8 === null),
        listIncomplete,
      );
    }
    return emitLines(ctx, deps.tamper !== undefined ? deps.tamper(lines) : lines, forbidden);
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'projects',
  owner: 'B3a',
  run: (ctx) => runProjects(ctx),
};

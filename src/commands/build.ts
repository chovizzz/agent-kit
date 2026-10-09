import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { loadKitConfig, loadOverlayFile } from '../build/config.js';
import { runPipeline } from '../build/pipeline.js';
import { buildReport } from '../build/report.js';
import {
  MANIFEST_NAME,
  assertOutDirNotLink,
  cleanPrevious,
  listUnmanaged,
  readPreviousOut,
  writeOut,
} from '../build/writer.js';
import type { BudgetReport } from '../contracts/budget.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { Overlay } from '../contracts/config.js';
import { outKey } from '../render/out-layout.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { existsSync, lstat } from '../io/read-fs.js';
import { mkdirp, writeFile } from '../io/safe-fs.js';
import { formatDiagnostic } from './lint-cmd.js';
import type { CommandDef } from './types.js';

interface BuildOptions {
  dryRun: boolean;
  report: boolean;
}

function parseBuildArgs(argv: readonly string[]): BuildOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });
  return { dryRun: values['dry-run'] === true, report: values.report === true };
}

function targetLine(t: BudgetReport['targets'][number]): string {
  const limit = [
    t.max_bytes !== undefined ? `max_bytes=${t.max_bytes}` : undefined,
    t.max_lines !== undefined ? `max_lines=${t.max_lines}` : undefined,
    t.hard_limit !== undefined ? `hard_limit=${t.hard_limit}` : undefined,
  ].filter((x) => x !== undefined);
  return `budget ${t.agent}: ${t.bytes} 字节 / ${t.lines} 行 [${t.level}] ${limit.join(' ')} limit_source=${t.limit_source}${t.blocking ? ' BLOCKING' : ''}`;
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 写 out/ 只用 out/ 之内的写入根(.state、KIT_TMP 不在其中):out/ 内部的链接再也引不到它们。 */
function narrowTo(io: IoContext, base: string): IoContext {
  return { ...io, writeRoots: io.writeRoots.filter((r) => within(base, r)) };
}

/** `.state` 及 `.state/reports` 不得是符号链接(存在时)。 */
async function assertStateNotLink(io: IoContext): Promise<void> {
  for (const p of [io.stateDir, path.join(io.stateDir, 'reports')]) {
    if (existsSync(p) && (await lstat(p)).isSymbolicLink()) {
      throw new Error(`${path.relative(io.repoRoot, p) || p} 是符号链接,拒绝写入`);
    }
  }
}

export const command: CommandDef = {
  name: 'build',
  summary: '合并 + 渲染到 out/(只写仓库内 out/)',
  phase: 'P0',
  ownerBlock: 'B19(集成;依赖 B05/B06/B07/B08)',
  flags: [
    { name: '--dry-run', description: '只打印将写的文件清单,不写盘' },
    { name: '--report', description: '另写 .state/reports/build.json 并打印(--dry-run 时只打印)' },
  ],
  async run(ctx) {
    const io = ctx.io;
    let opts: BuildOptions;
    try {
      opts = parseBuildArgs(ctx.argv);
    } catch (e) {
      ctx.stderr(
        `agent-kit build: ${(e as Error).message}\n用法:agent-kit [--root <dir>] [--overlay <path>] build [--dry-run] [--report]\n`,
      );
      return ExitCode.USAGE;
    }
    const emit = (ds: readonly Diagnostic[]): void => {
      for (const d of ds) ctx.stdout(`${formatDiagnostic(d)}\n`);
    };

    const loaded = loadKitConfig(io.repoRoot);
    if (loaded.config === undefined) {
      emit(loaded.diagnostics);
      return ExitCode.CHECK_FAILED;
    }
    let overlay: Overlay | undefined;
    if (ctx.overlayPath !== undefined) {
      const o = loadOverlayFile(ctx.overlayPath);
      if (o.overlay === undefined) {
        emit(o.diagnostics);
        return ExitCode.CHECK_FAILED;
      }
      overlay = o.overlay;
    }

    const res = await runPipeline({ root: io.repoRoot, config: loaded.config, overlay });
    if (res.kind === 'fail_closed') {
      ctx.stderr(`agent-kit build: ${res.message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    if (res.kind === 'check_failed') {
      emit(res.diagnostics);
      for (const n of res.notes) ctx.stdout(`build: ${n}\n`);
      return ExitCode.CHECK_FAILED;
    }

    emit(res.diagnostics);
    if (res.rendered.files.length === 0) {
      ctx.stdout(
        'warn BUILD_EMPTY_OUTPUT out/: 本次没有渲染出任何文件(仓库里没有可入 core 的规则/技能/子代理?)\n',
      );
    }
    for (const t of res.budget.targets) ctx.stdout(`${targetLine(t)}\n`);
    const files = res.rendered.files;
    const bytesByPath = new Map(
      files.map((f) => [outKey(f), Buffer.byteLength(f.content, 'utf8')]),
    );
    const report = canonicalJson(
      buildReport(res.manifest, bytesByPath, res.rendered.report, res.stats),
    );
    const manifestText = canonicalJson(res.manifest);
    const newPaths = new Set(files.map((f) => outKey(f)));

    const outIo = narrowTo(io, io.outDir);
    try {
      await assertOutDirNotLink(io);
      const prev = await readPreviousOut(outIo);
      if (prev.untrusted !== undefined) {
        ctx.stdout(
          `warn BUILD_PREVIOUS_MANIFEST_UNTRUSTED out/manifest.json: ${prev.untrusted},不据此清理\n`,
        );
      }

      if (opts.dryRun) {
        ctx.stdout('build --dry-run: 不写盘\n');
        for (const p of prev.paths.filter((p) => !newPaths.has(p)))
          ctx.stdout(`would remove out/${p}\n`);
        for (const m of res.manifest.files) {
          ctx.stdout(
            `would write out/${m.path} (${bytesByPath.get(m.path)} 字节, sha256=${m.sha256})\n`,
          );
        }
        ctx.stdout(
          `would write out/${MANIFEST_NAME} (${Buffer.byteLength(manifestText, 'utf8')} 字节)\n`,
        );
      } else {
        const modified = await cleanPrevious(outIo, prev, newPaths);
        for (const m of modified) {
          ctx.stdout(
            `warn BUILD_MODIFIED_MANAGED_FILE out/${m}: 内容与 manifest 登记的 sha256 不符(被手改?),未删除\n`,
          );
        }
        await writeOut(outIo, files, manifestText);
        const stray = await listUnmanaged(outIo, newPaths);
        for (const s of stray) {
          ctx.stdout(`warn BUILD_UNMANAGED_FILE out/${s}: 不是本次 build 产物,未触碰\n`);
        }
        ctx.stdout(`build: 已写 ${files.length} 个文件 + out/${MANIFEST_NAME}\n`);
      }
      ctx.stdout(
        `build: ${res.counts.core} 个原子可入 core 输出, ${res.counts.personal} 个 personal 原子已跳过(P2 才渲染); ${path.basename(io.outDir)}/ 共 ${files.length} 个文件(enforce=${res.budget.enforce})\n`,
      );

      if (opts.report) {
        if (opts.dryRun) {
          ctx.stdout(`--- build report (dry-run, 未写 .state/reports/build.json) ---\n${report}`);
        } else {
          await assertStateNotLink(io);
          const stateIo = narrowTo(io, io.stateDir);
          const dir = path.join(io.stateDir, 'reports');
          await mkdirp(stateIo, dir, 0o700);
          await writeFile(stateIo, path.join(dir, 'build.json'), report, { mode: 0o600 });
          ctx.stdout(`--- build report (.state/reports/build.json) ---\n${report}`);
        }
      }
    } catch (e) {
      ctx.stderr(`agent-kit build: 写 out/ 失败:${(e as Error).message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    return ExitCode.OK;
  },
};

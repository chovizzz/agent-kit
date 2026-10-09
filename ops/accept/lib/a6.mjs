// A6 reader 对照(硬门槛):4 agent × 5 样本 × 3 计数逐项等于独立 jq oracle。
// 本脚本只读 .state/reader-samples.local.txt 列出的文件,并先复制到只读副本;缺清单 => 4。
// 开发/测试一律用合成样本(test/fixtures/sessions/gen-*.ts 运行时生成),真实样本只由主代理验收时跑。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXIT_STUB,
  Reporter,
  chmodTree,
  cleanEnv,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
  sha256,
  vitestStep,
  distSrc,
} from './common.mjs';

export const AGENTS = ['claude', 'codex', 'pi', 'kimi'];
/** 各家保留的相对路径层数(口径 docs/reader-counting-spec.md §0 的"会话文件"行) */
export const TAIL = { claude: 2, codex: 4, pi: 2, kimi: 5 };
const SAMPLES_PER_AGENT = 5;
const FALLBACK_VERSION = '9.9.9';

export function parseLocalList(text) {
  const rows = [];
  const problems = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 2 || !AGENTS.includes(cols[0]) || !path.isAbsolute(cols[1])) {
      problems.push(`第 ${i + 1} 行格式错(要求 <agent>\\t<绝对路径>)`);
      continue;
    }
    rows.push({ agent: cols[0], file: cols[1] });
  }
  for (const a of AGENTS) {
    const n = rows.filter((r) => r.agent === a).length;
    if (n !== SAMPLES_PER_AGENT) problems.push(`${a} 样本数 ${n} != ${SAMPLES_PER_AGENT}`);
  }
  if (new Set(rows.map((r) => r.file)).size !== rows.length) problems.push('样本路径有重复');
  return { rows, problems };
}

export function parseInventoryList(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const [agent, h, lines] = raw.split('\t');
    rows.push({ agent, hash: h, lines: Number(lines) });
  }
  return rows;
}

export function countNewlines(file) {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return n;
}

/** 本地清单与 inventory/reader-samples.txt 逐行对得上(路径哈希前 16 位 + 行数)。返回 problems[]。 */
export function verifyAgainstInventory(rows, inv) {
  const problems = [];
  for (const a of AGENTS) {
    const mine = rows
      .filter((r) => r.agent === a)
      .map((r) => `${sha256(r.file).slice(0, 16)}\t${countNewlines(r.file)}`)
      .sort();
    const theirs = inv
      .filter((r) => r.agent === a)
      .map((r) => `${r.hash}\t${r.lines}`)
      .sort();
    if (mine.join('\n') !== theirs.join('\n'))
      problems.push(`${a}: 本地样本与 inventory/reader-samples.txt 的(路径哈希,行数)不一致`);
  }
  return problems;
}

export function copyReadonly(rows, dest) {
  const placed = [];
  const counter = {};
  for (const r of rows) {
    const n = (counter[r.agent] = (counter[r.agent] ?? 0) + 1);
    const parts = r.file.split(path.sep).filter(Boolean);
    const tail = parts.slice(-TAIL[r.agent]);
    const source = path.join(dest, r.agent, String(n));
    const target = path.join(source, ...tail);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(r.file, target);
    if (r.agent === 'kimi') {
      // Kimi 的项目归属(cwd_hint)来自同会话目录的 state.json(<session>/state.json,wire 在 <session>/agents/main/)
      const companion = path.join(path.dirname(r.file), '..', '..', 'state.json');
      if (fs.existsSync(companion))
        fs.copyFileSync(companion, path.join(source, tail[0], tail[1], 'state.json'));
    }
    placed.push({ ...r, n, source, copy: target });
  }
  chmodTree(dest, false);
  return placed;
}

export function readSignals(stateDir) {
  const out = [];
  const root = path.join(stateDir, 'signals');
  if (!fs.existsSync(root)) return out;
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.jsonl')) {
        for (const l of fs.readFileSync(p, 'utf8').split('\n'))
          if (l.trim()) out.push({ file: p, line: l });
      }
    }
  };
  walk(root);
  return out;
}

/** 独立于 reader 的版本对照(jq):claude 行内 .version;codex session_meta.payload.cli_version;pi/kimi 无。 */
export function oracleVersion(agent, file) {
  const prog = {
    claude: 'select(type=="object" and (.version|type)=="string")|.version',
    codex: 'select(type=="object" and .type=="session_meta")|.payload.cli_version // empty',
  }[agent];
  if (!prog) return null;
  const r = run('jq', ['-r', prog, file]);
  if (r.status !== 0) return undefined;
  const first = r.stdout.split('\n').find((l) => l.trim() !== '');
  return first ?? null;
}

async function a6(argv) {
  const R = new Reporter('A6');
  const { flags } = parseCommon(argv, {
    value: ['samples', 'inventory', 'oracle'],
    multi: ['allow-project'],
    bool: ['no-vitest'],
  });
  const ctx = makeCtx(flags);
  const tmp = mkTmp(ctx, 'a6');
  try {
    if (!flags.noVitest) {
      vitestStep(
        R,
        ctx,
        tmp,
        'vitest test/readers test/signals(合成会话端到端、未知事件、只读打开)',
        ['test/readers', 'test/signals'],
        {
          dirs: ['test/readers', 'test/signals'],
        },
      );
    }
    const samplesFile = path.resolve(
      flags.samples ?? path.join(ctx.root, '.state', 'reader-samples.local.txt'),
    );
    if (!fs.existsSync(samplesFile)) {
      R.notRun(`样本清单缺失:${samplesFile}(真实 A6 未执行;硬门槛,不得当通过)`);
      return R.exit();
    }
    const { rows, problems } = parseLocalList(fs.readFileSync(samplesFile, 'utf8'));
    if (problems.length) {
      for (const p of problems) R.rejected(`样本清单:${p}`);
      return R.exit();
    }
    const missing = rows.filter((r) => !fs.existsSync(r.file) || !fs.statSync(r.file).isFile());
    if (missing.length) {
      R.notRun(`${missing.length} 个样本文件不存在或不是文件(清单过期?)`);
      return R.exit();
    }
    const invFile = path.resolve(
      flags.inventory ?? path.join(ctx.root, 'inventory', 'reader-samples.txt'),
    );
    if (!fs.existsSync(invFile)) {
      R.rejected(`缺 ${invFile}:无法确认本地样本就是盘点选定的样本`);
      return R.exit();
    }
    const invProblems = verifyAgainstInventory(
      rows,
      parseInventoryList(fs.readFileSync(invFile, 'utf8')),
    );
    if (invProblems.length) {
      for (const p of invProblems) R.rejected(p);
      return R.exit();
    }
    if (!fs.existsSync(ctx.cli)) {
      R.notRun(`找不到 CLI:${ctx.cli}`);
      return R.exit();
    }
    const oracle = path.resolve(
      flags.oracle ?? path.join(ctx.root, 'ops', 'reader-oracle', 'run.sh'),
    );
    if (!fs.existsSync(oracle)) {
      R.notRun(`找不到 oracle:${oracle}`);
      return R.exit();
    }

    // 只读副本
    const roDir = path.join(tmp, 'ro-samples');
    const placed = copyReadonly(rows, roDir);
    const sbx = sandbox(tmp);
    const homeDir = sbx.home;
    const allow = flags.allowProject.length ? flags.allowProject : ['social-ops-hub', 'skills-hub'];

    let signalSchema;
    try {
      signalSchema = (
        await import(pathToFileURL(path.join(distSrc(ctx), 'contracts', 'signal.js')).href)
      ).SignalSchema;
    } catch {
      signalSchema = null;
    }
    if (!signalSchema) {
      R.notRun(
        `取不到 SignalSchema(${path.join(distSrc(ctx), 'contracts', 'signal.js')}):信号字段无法按契约校验`,
      );
      return R.exit();
    }

    const perAgent = Object.fromEntries(
      AGENTS.map((a) => [
        a,
        { u: 0, t: 0, f: 0, signals: 0, versionOk: 0, versionTotal: 0, compared: 0 },
      ]),
    );
    let numbers = 0;
    let equal = 0;
    for (const s of placed) {
      const tag = `${s.agent}#${s.n}`;
      const stateDir = path.join(sbx.kit, `state-${s.agent}-${s.n}`);
      const args = [
        ctx.cli,
        '--root',
        ctx.root,
        'signals',
        'collect',
        '--agent',
        s.agent,
        '--source',
        s.source,
        '--cli-version',
        FALLBACK_VERSION,
        '--max-event-bytes',
        '67108864',
        ...allow.flatMap((p) => ['--allow-project', p]),
      ];
      const r = run(ctx.node, args, {
        cwd: ctx.root,
        env: cleanEnv({ HOME: homeDir, KIT_TMP: sbx.kit, KIT_STATE_DIR: stateDir }),
      });
      if (r.status === EXIT_STUB) {
        R.notRun(`${tag}: signals collect 是命令桩`);
        continue;
      }
      if (r.status !== 0) {
        R.fail(`${tag}: signals collect 退出 ${r.status} :: ${r.stderr.slice(0, 200)}`);
        continue;
      }
      let out;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        R.fail(`${tag}: signals collect 输出不是 JSON`);
        continue;
      }
      if (out.sessions?.length !== 1) {
        R.fail(
          `${tag}: 应恰好发现并处理 1 个会话,实际 ${out.sessions?.length}(目录布局或项目过滤把样本滤掉了?)`,
        );
        continue;
      }
      const c = out.sessions[0].counts;
      if ((c.oversized_lines ?? 0) > 0) {
        R.attribute(
          `${tag}: oversized_lines=${c.oversized_lines},按口径 C8 该样本不能用于比对(待设计者 D3)`,
        );
        continue;
      }
      const o = run('bash', [oracle, s.agent, s.copy]);
      let oc;
      try {
        oc = JSON.parse(o.stdout.trim());
      } catch {
        oc = null;
      }
      if (o.status !== 0 || !oc) {
        R.fail(`${tag}: oracle 失败(exit ${o.status})`);
        continue;
      }
      const pairs = [
        ['user_messages', 'u'],
        ['tool_calls', 't'],
        ['tool_failures', 'f'],
      ];
      const diffs = [];
      for (const [k, short] of pairs) {
        numbers++;
        if (c[k] === oc[k]) equal++;
        else diffs.push(`${k}: reader=${c[k]} oracle=${oc[k]}`);
        perAgent[s.agent][short] += oc[k];
      }
      if (diffs.length) R.fail(`${tag}: 计数不等 ${diffs.join('; ')}`);
      else
        R.pass(
          `${tag}: 三计数与 oracle 相等 (u=${oc.user_messages} t=${oc.tool_calls} f=${oc.tool_failures})`,
        );

      // 信号字段与版本来源
      const sigs = readSignals(stateDir);
      perAgent[s.agent].compared++;
      perAgent[s.agent].signals += sigs.length;
      const expectedVersion = oracleVersion(s.agent, s.copy);
      for (const { line } of sigs) {
        let sg;
        try {
          sg = JSON.parse(line);
        } catch {
          R.fail(`${tag}: 信号行不是 JSON`);
          continue;
        }
        if (!signalSchema.safeParse(sg).success) R.fail(`${tag}: 信号不符 SignalSchema`);
        for (const k of ['agent', 'session_ref', 'ts', 'type']) {
          if (typeof sg[k] !== 'string' || sg[k] === '') R.fail(`${tag}: 信号字段 ${k} 为空`);
        }
        perAgent[s.agent].versionTotal++;
        const wantSource = expectedVersion ? 'session_meta' : 'collector_fallback';
        const wantVersion = expectedVersion ?? FALLBACK_VERSION;
        if (
          expectedVersion !== undefined &&
          sg.agent_version_source === wantSource &&
          sg.agent_version === wantVersion
        )
          perAgent[s.agent].versionOk++;
      }
    }
    // 版本来源判定与正向控制
    for (const a of AGENTS) {
      const p = perAgent[a];
      if (p.compared !== SAMPLES_PER_AGENT) continue; // 有样本没比成时,上面已有具体失败,不再叠加空比对噪声
      if (p.signals === 0) R.fail(`${a}: 5 个样本一条信号都没产出(非空率检查会空通过)`);
      if (p.versionTotal > 0 && p.versionOk !== p.versionTotal)
        R.fail(`${a}: agent_version/来源与对照不一致 ${p.versionOk}/${p.versionTotal}`);
      for (const [k, v] of [
        ['user_messages', p.u],
        ['tool_calls', p.t],
        ['tool_failures', p.f],
      ]) {
        if (v === 0)
          R.fail(
            `${a}: 5 个样本的 ${k} 全为 0(60 个数字相等可能是空比对;口径 §5 要求每类至少 1 个样本 > 0)`,
          );
      }
    }
    // 脱敏复扫:对产出的信号文件逐个 redact --stdin --check
    for (const s of placed) {
      const stateDir = path.join(sbx.kit, `state-${s.agent}-${s.n}`);
      for (const { file } of readSignals(stateDir).filter(
        (x, i, arr) => arr.findIndex((y) => y.file === x.file) === i,
      )) {
        const r = run(
          ctx.node,
          [ctx.cli, '--root', ctx.root, 'redact', '--stdin', '--check', '--timeout-ms', '5000'],
          {
            input: fs.readFileSync(file, 'utf8'),
            cwd: ctx.root,
            env: cleanEnv({ HOME: homeDir, KIT_TMP: sbx.kit }),
          },
        );
        if (r.status !== 0)
          R.fail(
            `${s.agent}#${s.n}: 信号输出脱敏复扫退出 ${r.status} ${r.stderr.split('\n')[0].slice(0, 100)}`,
          );
      }
    }
    R.info(`逐项相等 ${equal}/${numbers}(目标 60/60)`);
    if (numbers !== 60) R.fail(`参与比对的数字 ${numbers} != 60(有样本没比成)`);
    // Codex CommandExecution 失败正例:口径 §5 要求,jq oracle 拿不到,需人工确认
    R.info(
      '人工确认项:Codex 样本须含 1 个 CommandExecution failed 正例(B16 样本头已声明;脚本不读会话正文,无法自动核)',
    );
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A6', () => a6(process.argv.slice(2)));

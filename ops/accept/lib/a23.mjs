// A23 生命周期端到端(合成仓库、进程内 stub 后端,不联网、不起 LLM):
//   reflect(stub)→ judge(stub,跨厂商)→ promote --run --write → git apply → commit → 守卫 kit:reflector
//   → promote --rule --to advisory → apply → commit → 守卫 kit:promotion
//   → 造满足阈值的 attest 夹具 → 守卫 kit:attest
//   → promote --rule --to active → apply → commit → 守卫 kit:promotion
//   → retire --to deprecated --reason manual → apply → commit → 守卫 kit:retire
//   → 打 stable tag → retire --to retired → apply → commit → 守卫 kit:retire
//   → 删除 retired 原子(G4 流程:无 tag 覆盖时被拒、tag 覆盖后放行,守卫跑真 G4)
//   → 再采纳同 id 提案被 C7 墓碑拒(ID_TOMBSTONED,不是 ID_EXISTS_IN_REPO);拿走墓碑目录后同一采纳不再被 C7 拒(对照)。
// 每一步补丁都用真 `git apply --check --whitespace=error` 验证,并在应用后的树上跑真 `check --guards --label <对应 label>`(退出 0)。
// 防假绿:每一步都核对 stdout 的计数/状态而不只是退出码;反向对照(无 tag 删除被拒、去掉墓碑后不被拒)证明被测门真的在工作。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Reporter, makeCtx, mkTmp, parseCommon, rmTmp, runMain } from './common.mjs';
import { freshDist, importDist } from './accept-p1.mjs';
import {
  CODEOWNERS,
  applyPatchFile,
  attestFile,
  commitFiles,
  commitStaged,
  git,
  gitEnvFor,
  headOf,
  initRepo,
  kitToml,
  loadWorldMods,
} from './lc-world.mjs';

const RUN_ID = 'run-20261012T080000Z-abc123';
const OWNER = '@owner-handle';
const RULE_ID = 'run-lint-before-commit';
const RULE = `rules/team/${RULE_ID}.md`;
const PROPOSAL = 'proposals/2026-10-12-001.yaml';
const LESSON_A = '以后提交代码前必须先运行 lint 检查 CANARY_E2E_ok';
const LESSON_B = '以后提交代码前必须先运行 lint 检查并修复告警';
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';
const at = (day, time = '08:00:00') => `${day}T${time}Z`;

/** Claude Code 合成会话(用户消息 + 两次工具调用,其中一次失败),时间戳从 2026-10-01 起 */
function sessionText(cwd, id, users) {
  const base = Date.UTC(2026, 9, 1);
  let t = 0;
  const ts = () => new Date(base + 1000 * t++).toISOString();
  const common = { sessionId: id, cwd, version: '2.1.294' };
  const lines = [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })];
  for (const text of users)
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: ts(),
        ...common,
        message: { role: 'user', content: text },
      }),
    );
  for (let i = 0; i < 2; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: ts(),
        ...common,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: ts(),
        ...common,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `tu_${i}`,
              content: i === 0 ? 'error: boom' : 'done',
              ...(i === 0 ? { is_error: true } : {}),
            },
          ],
        },
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** 进程内假后端:不 spawn、不联网 */
class Stub {
  constructor(slot, vendor, model, script) {
    this.slot = slot;
    this.vendor = vendor;
    this.model = model;
    this.script = script;
    this.calls = 0;
  }
  async complete(req) {
    this.calls++;
    return this.script(req);
  }
}

const aliasOf = (user, needle) => {
  for (const m of user.matchAll(/<evidence id="(e\d+)"[^>]*>([^<]*)<\/evidence>/g))
    if ((m[2] ?? '').includes(needle)) return m[1];
  throw new Error(`提示里没有含 ${needle} 的证据`);
};

const draft = (user) => ({
  op: 'add',
  id: RULE_ID,
  title: '提交前先跑 lint',
  do: '提交前先运行项目的 lint 并修复全部告警。',
  why: '带告警的提交会让评审与 CI 反复返工。',
  verify: '提交前的终端记录里能看到 lint 通过。',
  kind: 'practice',
  volatility: 'stable',
  signature: { type: 'phrase', pattern: 'git commit' },
  evidence: [aliasOf(user, 'CANARY_E2E_ok'), aliasOf(user, LESSON_B)],
  rationale: '多个项目的用户都要求提交前先跑 lint。',
});

const JUDGE_OK = JSON.stringify({
  verdict: 'accept',
  overfit_risk: 'low',
  generality: 'high',
  volatile: false,
  conflicts: [],
  injection_suspected: false,
  notes: 'looks fine',
});

async function a23(argv) {
  const R = new Reporter('A23');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);
  const fresh = freshDist(ctx);
  if (!fresh.ok) {
    R.notRun(fresh.why);
    return R.exit();
  }
  const D = {
    reflect: await importDist(ctx, 'commands/reflect.js'),
    judge: await importDist(ctx, 'commands/judge.js'),
    promote: await importDist(ctx, 'commands/promote.js'),
    retire: await importDist(ctx, 'commands/retire.js'),
    collect: await importDist(ctx, 'commands/signals-collect.js'),
    guards: await importDist(ctx, 'commands/guards-cmd.js'),
    paths: await importDist(ctx, 'io/paths.js'),
    redact: await importDist(ctx, 'redact/index.js'),
    stage: await importDist(ctx, 'reflect/stage.js'),
    checks: await importDist(ctx, 'lifecycle/checks.js'),
  };
  const wmods = await loadWorldMods(ctx);

  const tmp = mkTmp(ctx, 'a23');
  try {
    const kitTmp = path.join(tmp, 'kit');
    const state = path.join(kitTmp, 'state');
    const githome = path.join(kitTmp, 'githome');
    const repo = path.join(tmp, 'repo');
    const sessions = path.join(tmp, 'sessions');
    const overlayPath = path.join(tmp, 'overlay.toml');
    for (const d of [kitTmp, sessions]) fs.mkdirSync(d, { recursive: true });
    const io = D.paths.createIoContext({
      cwd: repo,
      root: repo,
      env: { KIT_TMP: kitTmp, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
    });
    const redactor = D.redact.createRedactor({ timeout_ms: 5000 });
    const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: githome };
    const exec = async (cmd, args, over = {}) => {
      const out = [];
      const err = [];
      const code = await cmd.run({
        argv: args,
        io: over.io ?? io,
        overlayPath: over.overlay === null ? undefined : (over.overlay ?? overlayPath),
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
      });
      return { code, out: out.join(''), err: err.join('') };
    };
    const jsonOf = (r) => {
      try {
        return JSON.parse(r.out);
      } catch {
        return undefined;
      }
    };
    const clock = (iso) => () => new Date(iso);
    const promoteCmd = (now) =>
      D.promote.createPromoteCommand({ redactor, now: clock(now), gitEnv });
    const retireCmd = (now) => D.retire.createRetireCommand({ now: clock(now), gitEnv });
    const guards = async (base, head, label, repoIo = io) => {
      const out = [];
      const err = [];
      const code = await D.guards.run(
        {
          argv: [],
          io: repoIo,
          overlayPath: undefined,
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
        },
        { guards: true, base, head, label, report: false },
      );
      return { code, out: out.join(''), err: err.join('') };
    };
    const stop = (msg) => {
      R.fail(msg);
      return R.exit();
    };
    const step = (name) => (cond, detail) => {
      if (cond) R.pass(`${name}:${detail}`);
      else R.fail(`${name}:${detail}`);
      return cond;
    };

    // ---------- 仓库 + 合成会话 + 信号 ----------
    initRepo(repo, githome);
    commitFiles(
      repo,
      githome,
      { 'kit.toml': kitToml(), CODEOWNERS, '.gitignore': '.state/\nout/\n' },
      'base',
      at('2026-10-01'),
    );
    for (const [proj, id, users] of [
      ['proj-a', UUID_A, [LESSON_A, '你好']],
      ['proj-b', UUID_B, [LESSON_B]],
    ]) {
      fs.mkdirSync(path.join(sessions, proj), { recursive: true });
      fs.writeFileSync(
        path.join(sessions, proj, `${id}.jsonl`),
        sessionText(`/work/${proj}`, id, users),
      );
    }
    const collectRes = await exec(
      D.collect.command,
      [
        '--source',
        sessions,
        '--agent',
        'claude',
        '--allow-project',
        'proj-a',
        '--allow-project',
        'proj-b',
      ],
      { overlay: null },
    );
    if (collectRes.code !== 0)
      return stop(`准备:signals collect 退出 ${collectRes.code}:${collectRes.err.slice(0, 120)}`);
    const keys = new Set();
    const sigDir = path.join(state, 'signals', 'claude');
    for (const f of fs.readdirSync(sigDir))
      for (const line of fs.readFileSync(path.join(sigDir, f), 'utf8').split('\n'))
        if (line.trim() !== '') keys.add(JSON.parse(line).project_key);
    if (keys.size !== 2) return stop(`准备:信号库里应有 2 个 project_key,实际 ${keys.size}`);
    fs.writeFileSync(
      overlayPath,
      `[reflect]\negress = true\nbackends = [{ slot = "glm", cli = "pi" }]\nteam_project_keys = ${JSON.stringify([...keys])}\n`,
    );

    // ---------- reflect(stub) ----------
    const reflectStub = new Stub('glm', 'zhipu', 'glm-example', (req) => ({
      ok: true,
      text: JSON.stringify({ proposals: [draft(req.user)] }),
    }));
    const reflectCmd = D.reflect.createReflectCommand({
      clock: clock(at('2026-10-12')),
      randomHex: () => 'abc123',
      redactor,
      createBackends: () => ({ glm: reflectStub }),
    });
    const rf = await exec(reflectCmd, ['--run-llm', '--allow-egress', '--owner', OWNER, '--json']);
    if (
      !step('reflect(stub)')(
        rf.code === 0 && reflectStub.calls === 1,
        `退出 ${rf.code},后端调用 ${reflectStub.calls} 次 ${rf.err.slice(0, 100)}`,
      )
    )
      return R.exit();
    const stagedDir = D.stage.stageDir(io, RUN_ID);
    if (
      !step('reflect(stub)')(
        fs.existsSync(path.join(stagedDir, RULE)) && fs.existsSync(path.join(stagedDir, PROPOSAL)),
        '暂存区里有规则与提案',
      )
    )
      return R.exit();

    // ---------- judge(stub,跨厂商) ----------
    const judgeStubs = {
      codex: new Stub('codex', 'openai', 'gpt-example', () => ({ ok: true, text: JUDGE_OK })),
      kimi: new Stub('kimi', 'moonshot', 'kimi-example', () => ({ ok: true, text: JUDGE_OK })),
    };
    const judgeCmd = D.judge.createJudgeCommand({
      requireOverlayEgress: false,
      createBackends: () => judgeStubs,
      redactor,
    });
    const jd = await exec(judgeCmd, ['--run', RUN_ID, '--run-llm', '--allow-egress']);
    if (
      !step('judge(stub)')(
        jd.code === 0 && judgeStubs.codex.calls === 1,
        `退出 ${jd.code},codex 槽位调用 ${judgeStubs.codex.calls} 次 ${jd.err.slice(0, 100)}`,
      )
    )
      return R.exit();
    const stagedProposal = fs.readFileSync(path.join(stagedDir, PROPOSAL), 'utf8');
    if (
      !step('judge(stub)')(
        /\njudge:/.test(`\n${stagedProposal}`) && stagedProposal.includes('rule_sha256:'),
        '暂存提案含 judge 记录且写了 rule_sha256',
      )
    )
      return R.exit();
    const oldPatch = fs.readFileSync(path.join(stagedDir, 'apply.patch'), 'utf8');
    step('judge(stub)')(
      !oldPatch.includes('+judge:'),
      '对照:暂存区里旧的 apply.patch 不含 judge(这正是 promote --run 要修的缺口)',
    );

    // ---------- 一步:生成补丁 → git apply → commit → 守卫 ----------
    const patchFrom = (dir, name) => path.join(state, dir, name);
    const applyStep = (label, patchPath, msg, date) => {
      const base = headOf(repo, githome);
      const bad = applyPatchFile(repo, githome, patchPath);
      if (bad !== '') {
        R.fail(`${label}:${bad}`);
        return undefined;
      }
      commitStaged(repo, githome, msg, date);
      return { base, head: headOf(repo, githome) };
    };
    const guardStep = async (label, pair, glabel) => {
      const g = await guards(pair.base, pair.head, glabel);
      const ok = g.code === 0 && /0 error/.test(g.out);
      step(label)(
        ok,
        `应用后 check --guards --label ${glabel} ${ok ? '绿' : `红(退出 ${g.code}):${(g.out + g.err).slice(0, 200)}`}`,
      );
      return ok;
    };

    // T0 采纳
    const ad = await exec(promoteCmd(at('2026-10-12')), ['--run', RUN_ID, '--write', '--json']);
    const adj = jsonOf(ad);
    if (
      !step('promote --run')(
        ad.code === 0 && adj?.adopted === 1 && adj?.wrote === true,
        `退出 ${ad.code},adopted=${adj?.adopted} wrote=${adj?.wrote} ${ad.err.slice(0, 100)}`,
      )
    )
      return R.exit();
    const adPatch = patchFrom('promote', `${adj.promo_id}/promote.patch`);
    step('promote --run')(
      fs.readFileSync(adPatch, 'utf8').includes('+judge:'),
      '新补丁含 judge 记录(以新补丁为准,旧 apply.patch 作废)',
    );
    const p0 = applyStep('采纳', adPatch, 'adopt proposal', at('2026-10-12', '09:00:00'));
    if (p0 === undefined) return R.exit();
    step('采纳')(true, '补丁 git apply --check --whitespace=error 通过并已提交');
    if (!(await guardStep('采纳', p0, 'kit:reflector'))) return R.exit();
    const adopted = fs.readFileSync(path.join(repo, RULE), 'utf8');
    step('采纳')(adopted.includes('status: proposed'), '入库状态是 proposed');

    // T1 proposed -> advisory
    const t1 = await exec(promoteCmd(at('2026-10-13')), [
      '--rule',
      RULE_ID,
      '--to',
      'advisory',
      '--write',
      '--json',
    ]);
    const t1j = jsonOf(t1);
    if (
      !step('promote -> advisory')(
        t1.code === 0 && t1j?.from === 'proposed' && t1j?.to === 'advisory' && t1j?.wrote === true,
        `退出 ${t1.code} ${t1.err.slice(0, 100)}`,
      )
    )
      return R.exit();
    const p1 = applyStep(
      '晋升 advisory',
      patchFrom('promote', `${t1j.promo_id}/promote.patch`),
      'promote to advisory',
      at('2026-10-13', '00:00:00'),
    );
    if (p1 === undefined) return R.exit();
    step('晋升 advisory')(true, '补丁 git apply --check --whitespace=error 通过并已提交');
    if (!(await guardStep('晋升 advisory', p1, 'kit:promotion'))) return R.exit();
    step('晋升 advisory')(
      fs.readFileSync(path.join(repo, RULE), 'utf8').includes('status: advisory'),
      '规则文件 status=advisory',
    );

    // T2 前:阈值未达必须被拒(对照),再造 attest
    const early = await exec(promoteCmd(at('2026-10-30')), [
      '--rule',
      RULE_ID,
      '--to',
      'active',
      '--json',
    ]);
    step('promote -> active(无 attest)')(
      early.code === 1 && /G3:THRESHOLD_/.test(early.out),
      `对照:没有 attest 时被拒(退出 ${early.code};${[...new Set(early.out.match(/G3:[A-Z_]+/g) ?? [])].join(',')})`,
    );
    const ruleText = fs.readFileSync(path.join(repo, RULE), 'utf8');
    const attests = ['@alice', '@bob'].map((member, i) =>
      attestFile(wmods, ruleText, {
        rule_id: RULE_ID,
        member,
        start: '2026-10-14',
        end: '2026-10-28',
        exposure: 10,
        run: `run-20261028T00000${i}Z-aaaaa${i}`,
      }),
    );
    const files = Object.fromEntries(attests);
    const baseA = headOf(repo, githome);
    commitFiles(repo, githome, files, 'attest evidence', at('2026-10-29'));
    if (
      !(await guardStep('attest 夹具', { base: baseA, head: headOf(repo, githome) }, 'kit:attest'))
    )
      return R.exit();

    const t2 = await exec(promoteCmd(at('2026-10-30')), [
      '--rule',
      RULE_ID,
      '--to',
      'active',
      '--today',
      '2026-10-30',
      '--write',
      '--json',
    ]);
    const t2j = jsonOf(t2);
    if (
      !step('promote -> active')(
        t2.code === 0 &&
          t2j?.from === 'advisory' &&
          t2j?.to === 'active' &&
          t2j?.attest_files === 2,
        `退出 ${t2.code},attest_files=${t2j?.attest_files} ${t2.err.slice(0, 120)}`,
      )
    )
      return R.exit();
    const p2 = applyStep(
      '晋升 active',
      patchFrom('promote', `${t2j.promo_id}/promote.patch`),
      'promote to active',
      at('2026-10-30', '08:00:00'),
    );
    if (p2 === undefined) return R.exit();
    step('晋升 active')(true, '补丁 git apply --check --whitespace=error 通过并已提交');
    if (!(await guardStep('晋升 active', p2, 'kit:promotion'))) return R.exit();
    step('晋升 active')(
      fs.readFileSync(path.join(repo, RULE), 'utf8').includes('status: active'),
      '规则文件 status=active',
    );

    // T4 active -> deprecated
    const t3 = await exec(retireCmd(at('2026-11-02')), [
      '--rule',
      RULE_ID,
      '--to',
      'deprecated',
      '--reason',
      'manual',
      '--write',
      '--json',
    ]);
    const t3j = jsonOf(t3);
    if (
      !step('retire -> deprecated')(
        t3.code === 0 && t3j?.from === 'active' && t3j?.to === 'deprecated' && t3j?.wrote === true,
        `退出 ${t3.code} ${t3.err.slice(0, 120)}`,
      )
    )
      return R.exit();
    const p3 = applyStep(
      '退役 deprecated',
      patchFrom('retire', `${t3j.retire_id}/retire.patch`),
      'retire to deprecated',
      at('2026-11-02', '08:00:00'),
    );
    if (p3 === undefined) return R.exit();
    step('退役 deprecated')(
      true,
      '补丁 git apply --check --whitespace=error 通过并已提交(含 lifecycle 记录)',
    );
    if (!(await guardStep('退役 deprecated', p3, 'kit:retire'))) return R.exit();
    step('退役 deprecated')(
      fs.readdirSync(path.join(repo, 'lifecycle', RULE_ID)).length === 1,
      'lifecycle/<id>/ 下有恰好 1 条审计记录(墓碑)',
    );

    // T5 deprecated -> retired:先证明冷却(没有 stable tag 时被拒),再打 tag
    const tooEarly = await exec(retireCmd(at('2026-11-05')), [
      '--rule',
      RULE_ID,
      '--to',
      'retired',
      '--reason',
      'manual',
      '--json',
    ]);
    step('retire -> retired(无 stable tag)')(
      tooEarly.code === 1 && /COOLDOWN_NOT_MET/.test(tooEarly.out + tooEarly.err),
      `对照:deprecated 未出现在任何祖先 stable tag 里时被拒(退出 ${tooEarly.code};${[...new Set(tooEarly.out.match(/COOLDOWN_NOT_MET/g) ?? [])].join(',')})`,
    );
    const tagEnv = gitEnvFor(githome, at('2026-11-03'));
    git(repo, ['tag', '-a', '-m', 'stable', 'stable-2026-11-03', p3.head], tagEnv);
    commitFiles(repo, githome, { 'NOTES.md': 'later\n' }, 'later', at('2026-11-04'));
    const t4 = await exec(retireCmd(at('2026-11-05')), [
      '--rule',
      RULE_ID,
      '--to',
      'retired',
      '--reason',
      'manual',
      '--write',
      '--json',
    ]);
    const t4j = jsonOf(t4);
    if (
      !step('retire -> retired')(
        t4.code === 0 && t4j?.from === 'deprecated' && t4j?.to === 'retired' && t4j?.wrote === true,
        `退出 ${t4.code} ${t4.err.slice(0, 120)}`,
      )
    )
      return R.exit();
    const p4 = applyStep(
      '退役 retired',
      patchFrom('retire', `${t4j.retire_id}/retire.patch`),
      'retire to retired',
      at('2026-11-05', '08:00:00'),
    );
    if (p4 === undefined) return R.exit();
    step('退役 retired')(true, '补丁 git apply --check --whitespace=error 通过并已提交');
    if (!(await guardStep('退役 retired', p4, 'kit:retire'))) return R.exit();

    // ---------- G4:删除 retired 原子文件 ----------
    commitFiles(repo, githome, { 'NOTES.md': 'later2\n' }, 'later2', at('2026-11-06'));
    const baseDel = headOf(repo, githome);
    // 对照:在 retired 还没出现在任何祖先 stable tag 之前删除 -> G4 拒(真 G4 路径)
    git(repo, ['checkout', '--quiet', '-B', 'g4-control'], gitEnvFor(githome));
    commitFiles(repo, githome, { [RULE]: null }, 'delete (control)', at('2026-11-07'));
    const ctl = await guards(baseDel, headOf(repo, githome), undefined);
    step('G4')(
      ctl.code === 1 && /GUARD_G4_NOT_IN_STABLE_TAG/.test(ctl.out + ctl.err),
      `对照:retired 尚未进任何 stable tag 时删除被 G4 拒(${(ctl.out + ctl.err).match(/GUARD_G4_[A-Z_]+/)?.[0] ?? `退出 ${ctl.code}`})`,
    );
    git(repo, ['checkout', '--quiet', 'main'], gitEnvFor(githome));
    git(
      repo,
      ['tag', '-a', '-m', 'stable', 'stable-2026-11-06', p4.head],
      gitEnvFor(githome, at('2026-11-06')),
    );
    commitFiles(repo, githome, { [RULE]: null }, 'delete retired atom', at('2026-11-08'));
    const del = await guards(baseDel, headOf(repo, githome), undefined);
    step('G4')(
      del.code === 0 && /0 error/.test(del.out),
      `tag 覆盖 retired 之后删除原子文件放行(真 G4,退出 ${del.code})`,
    );
    step('G4')(
      !fs.existsSync(path.join(repo, RULE)) && fs.existsSync(path.join(repo, 'lifecycle', RULE_ID)),
      '原子文件已删,lifecycle 记录(墓碑)仍在',
    );

    // ---------- 墓碑:再采纳同 id 被 C7 拒 ----------
    const re = await exec(promoteCmd(at('2026-11-09')), ['--run', RUN_ID, '--json']);
    const reText = re.out + re.err;
    step('墓碑')(
      re.code === 1 && /C7:ID_TOMBSTONED/.test(reText) && !/ID_EXISTS_IN_REPO/.test(reText),
      `原子文件已删后再采纳同 id 提案被 C7:ID_TOMBSTONED 拒(退出 ${re.code};不是 ID_EXISTS_IN_REPO)`,
    );
    // 对照:仓库里遗留的提案文件也会让采纳被丢(RAW:PROPOSAL_PATH_EXISTS);挪开它,单独看墓碑
    const propAside = path.join(tmp, 'proposal.aside');
    const propPath = path.join(repo, PROPOSAL);
    fs.renameSync(propPath, propAside);
    const onlyTomb = await exec(promoteCmd(at('2026-11-09')), ['--run', RUN_ID, '--json']);
    const onlyTombJ = jsonOf(onlyTomb);
    step('墓碑')(
      onlyTomb.code === 1 &&
        onlyTombJ?.adopted === 0 &&
        Object.keys(onlyTombJ?.dropped_by_reason ?? {}).join() === 'C7:ID_TOMBSTONED',
      `挪开遗留提案文件后,丢弃原因恰好只有 C7:ID_TOMBSTONED(${Object.keys(onlyTombJ?.dropped_by_reason ?? {}).join()})`,
    );
    // 对照:再把墓碑目录挪开,同一采纳通过
    const aside = path.join(tmp, 'lifecycle.aside');
    fs.renameSync(path.join(repo, 'lifecycle'), aside);
    const noTomb = await exec(promoteCmd(at('2026-11-09')), ['--run', RUN_ID, '--json']);
    fs.renameSync(aside, path.join(repo, 'lifecycle'));
    fs.renameSync(propAside, propPath);
    const noTombJ = jsonOf(noTomb);
    step('墓碑')(
      noTomb.code === 0 && noTombJ?.adopted === 1,
      `对照:再没有墓碑目录时同一采纳通过(退出 ${noTomb.code},adopted=${noTombJ?.adopted}),证明拒绝来自墓碑`,
    );
    void git;
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A23', () => a23(process.argv.slice(2)));

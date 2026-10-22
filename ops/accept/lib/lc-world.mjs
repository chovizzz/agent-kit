// A22 / A23 / A5 共用:生命周期合成仓库(git 仓库 + kit.toml + team 层原子 + 提案 + attest + lifecycle 记录)。
// 全部合成数据;git 子进程用白名单 env(HOME 指向仓库外的空目录、不读全局/系统配置),提交时间固定,所以提交 oid 稳定。
// 内容由 dist 里的真函数计算(规则哈希、attest/lifecycle 文件名),与产品口径一致。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './common.mjs';
import { importDist } from './accept-p1.mjs';

export const OWNER = '@owner-handle';
export const DEFAULT_DATE = '2026-10-08T00:00:00Z';

export async function loadWorldMods(ctx) {
  return {
    yaml: await import('yaml'),
    checks: await importDist(ctx, 'lifecycle/checks.js'),
    attest: await importDist(ctx, 'contracts/attest.js'),
    lifecycle: await importDist(ctx, 'contracts/lifecycle.js'),
  };
}

// ---------------------------------------------------------------- git

const IDENT = [
  '-c',
  'user.name=kit-accept',
  '-c',
  'user.email=kit-accept@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
];

/** 起 git 用的 env:HOME 必须是调用方给的空目录(在 KIT_TMP 之内,产品的 exec 白名单也要求这样) */
export function gitEnvFor(home, date = DEFAULT_DATE) {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

export function git(dir, args, env, input) {
  const r = spawnSync('git', [...IDENT, ...args], {
    cwd: dir,
    env: cleanEnv(env),
    encoding: 'utf8',
    input,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')} 失败(${r.status}):${String(r.stderr).slice(0, 200)}`);
  return r.stdout;
}

/** 新建仓库目录 + git init;home 是 git 的 HOME(空目录)。 */
export function initRepo(dir, home) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  git(dir, ['init', '--quiet', '--template='], gitEnvFor(home));
  git(dir, ['config', 'maintenance.auto', 'false'], gitEnvFor(home));
  git(dir, ['config', 'gc.auto', '0'], gitEnvFor(home));
}

/** 写文件(增量;null = 删除)并提交,返回提交 oid。date 固定提交时间。 */
export function commitFiles(dir, home, files, message, date = DEFAULT_DATE) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (text === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return commitStaged(dir, home, message, date);
}

/** 提交工作树里当前的全部改动(`add -A`),返回提交 oid */
export function commitStaged(dir, home, message, date = DEFAULT_DATE) {
  const env = gitEnvFor(home, date);
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', message], env);
  return git(dir, ['rev-parse', 'HEAD'], env).trim();
}

export const headOf = (dir, home) => git(dir, ['rev-parse', 'HEAD'], gitEnvFor(home)).trim();

/** 补丁一律用真 git 检查并应用:先 --check --whitespace=error,再 apply。返回问题文本(空 = 成功) */
export function applyPatchFile(dir, home, patchFile) {
  const env = gitEnvFor(home);
  const chk = spawnSync('git', ['apply', '--check', '--whitespace=error', patchFile], {
    cwd: dir,
    env: cleanEnv(env),
    encoding: 'utf8',
  });
  if (chk.status !== 0) return `git apply --check 失败:${String(chk.stderr).slice(0, 160)}`;
  const ap = spawnSync('git', ['apply', '--whitespace=error', patchFile], {
    cwd: dir,
    env: cleanEnv(env),
    encoding: 'utf8',
  });
  if (ap.status !== 0) return `git apply 失败:${String(ap.stderr).slice(0, 160)}`;
  return '';
}

// ---------------------------------------------------------------- 内容

export const BODY =
  '**做**:做某件具体的事。\n**为什么**:因为某个原因。\n**怎么验**:用某种方式验证。\n';

export function kitToml(members = [OWNER, '@alice', '@bob'], extra = '') {
  return `[kit]
name = "accept"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = 100000
limit_source = "documented"

[channels.canary.members]
${members.map((m) => `"${m}" = {}`).join('\n')}

[channels.stable.members]
${extra}`;
}

export const CODEOWNERS = `rules/** ${OWNER}\nproposals/** ${OWNER}\nlifecycle/** ${OWNER}\nattest/** ${OWNER}\n`;

/** team 层原子全文。signature 缺省 phrase('lint'),attest 才数得了 */
export function atomText(o = {}) {
  const id = o.id ?? 'sample-rule';
  const pid = o.pid ?? '2026-10-08-001';
  return (
    [
      '---',
      `id: ${id}`,
      `title: ${o.title ?? '示例规则'}`,
      `layer: ${o.layer ?? 'team'}`,
      `strength: ${o.strength ?? 'should'}`,
      'kind: practice',
      'volatility: stable',
      `status: ${o.status ?? 'proposed'}`,
      `owner: '${o.owner ?? OWNER}'`,
      `created: ${o.created ?? '2026-10-08'}`,
      `review_by: ${o.review_by ?? '2027-01-06'}`,
      'evidence:',
      '  - type: memory',
      '    ref: sig-1',
      '    excerpt: 合成摘录',
      'verifier:',
      '  type: none',
      ...(o.signature === false
        ? []
        : ['signature:', '  type: phrase', `  pattern: ${o.pattern ?? 'lint'}`]),
      ...(o.origin === null ? [] : [`origin: ${o.origin ?? `proposal/${pid}`}`]),
      '---',
      '',
    ].join('\n') + (o.body ?? BODY)
  );
}

/** 与 atomText 配套的提案(judge 记录绑定当前规则哈希) */
export function proposalYaml(mods, atom, o = {}) {
  const id = o.id ?? 'sample-rule';
  const pid = o.pid ?? '2026-10-08-001';
  const doc = {
    id: pid,
    op: 'add',
    targets: [id],
    layer: 'team',
    rationale: '合成的理由',
    evidence: [{ sig: 'sig-1', project_key: 'proj-a', excerpt: '合成摘录' }],
    budget_delta_bytes: 100,
    paired_retirements: [],
    cases: [],
    reflector: {
      provider: 'anthropic',
      vendor: 'anthropic',
      model: 'claude-x',
      run_id: 'run-20261008T000000Z-aaaaaa',
      backend: 'claude',
    },
    judge: {
      hops: [{ hop: 'codex', vendor: 'openai', model: 'gpt-6.1-sol', result: 'ok' }],
      provider: 'codex',
      vendor: 'openai',
      verdict: 'accept',
      overfit_risk: 'low',
      injection_suspected: false,
      conflicts: [],
      rule_sha256: mods.checks.ruleSha256(atom),
    },
  };
  return mods.yaml.stringify(doc);
}

/** attest 文件:返回 [仓库相对路径, 文本] */
export function attestFile(mods, atom, o = {}) {
  const a = {
    schema_version: 1,
    rule_id: o.rule_id ?? 'sample-rule',
    rule_sha256: o.hash ?? mods.checks.ruleSha256(atom),
    channel: o.channel ?? 'canary',
    member: o.member ?? '@alice',
    window_start: o.start ?? '2026-10-08',
    window_end: o.end ?? '2026-10-22',
    kit_version: '0.1.0',
    collector_versions: {},
    sessions_total: 40,
    exposure_sessions: o.exposure ?? 10,
    exposure_projects: 1,
    fired: 1,
    harmful: o.harmful ?? 0,
    recurrence: 0,
    signal_ids_digest: `sha256:${'0'.repeat(64)}`,
    run_id: o.run ?? 'run-20261023T000000Z-aaaaaa',
    method: 'signature_proxy_v1',
    // 冻结验收协议的哈希(K4):缺省不写 = 旧格式 attest,G3 不计入;需要计入的夹具传 o.acceptance
    ...(o.acceptance !== undefined ? { acceptance_sha256: o.acceptance } : {}),
  };
  const name = mods.attest.attestFileName({
    member: a.member,
    window_end: a.window_end,
    run_id: a.run_id,
  });
  return [`attest/${a.rule_id}/${name}`, `${JSON.stringify(a)}\n`];
}

/**
 * 干跑世界:一个 git 仓库,含
 *  - `to-promote`:proposed 原子 + 提案(含 judge 记录)——给 `promote --rule … --to advisory`;
 *  - `to-retire`:active 原子——给 `retire --rule … --to deprecated --reason manual`;
 *  - `to-attest`:advisory 原子(签名 phrase 'lint')——给 `attest`(信号由调用方另行准备)。
 * 返回各原子 id 与仓库路径。
 */
export function buildDryWorld(mods, repo, home) {
  initRepo(repo, home);
  const promote = atomText({
    id: 'to-promote',
    pid: '2026-10-08-001',
    pattern: 'zzz-promote-sample',
  });
  const files = {
    'kit.toml': kitToml(),
    CODEOWNERS,
    'rules/team/to-promote.md': promote,
    'proposals/2026-10-08-001.yaml': proposalYaml(mods, promote, {
      id: 'to-promote',
      pid: '2026-10-08-001',
    }),
    'rules/team/to-retire.md': atomText({
      id: 'to-retire',
      status: 'active',
      pid: '2026-10-08-002',
      pattern: 'deploy',
      body: '**做**:部署之前先确认数据库迁移已经全部应用并且回滚脚本可用。\n**为什么**:漏掉迁移会让新版本启动即崩溃,影响线上全部用户。\n**怎么验**:部署记录里能看到迁移完成的输出。\n',
    }),
    'rules/team/to-attest.md': atomText({
      id: 'to-attest',
      status: 'advisory',
      pid: '2026-10-08-003',
      body: '**做**:提交代码之前请先运行 lint 检查,修复全部告警再提交到主分支。\n**为什么**:带告警的提交会让评审与持续集成反复返工。\n**怎么验**:提交前的终端记录里能看到 lint 通过。\n',
    }),
  };
  commitFiles(repo, home, files, 'dry world');
  return { promote: 'to-promote', retire: 'to-retire', attest: 'to-attest' };
}

// ---------------------------------------------------------------- 合成会话 + 信号采集

/** Claude Code 合成会话文件内容(只含用户消息;时间戳从 2026-10-01 起每条 +1 秒) */
export function claudeSession(cwd, id, users) {
  return [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
    ...users.map((text, i) =>
      JSON.stringify({
        type: 'user',
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
        sessionId: id,
        cwd,
        version: '2.1.294',
        message: { role: 'user', content: text },
      }),
    ),
    '',
  ].join('\n');
}

// Claude reader 只认 <UUID>.jsonl 的文件名
export const UUID_A = '00000000-0000-4000-8000-0000000000a1';
export const UUID_B = '00000000-0000-4000-8000-0000000000b2';
export const LESSON = '以后提交代码前必须先运行 lint 检查并修复全部告警';

/** 写两个项目的合成会话到 sessionsDir(各含一条"教训"),返回两个项目目录名 */
export function writeSessions(sessionsDir) {
  fs.mkdirSync(path.join(sessionsDir, 'proj-a'), { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, 'proj-b'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'proj-a', `${UUID_A}.jsonl`),
    claudeSession('/work/proj-a', UUID_A, [LESSON, '你好']),
  );
  fs.writeFileSync(
    path.join(sessionsDir, 'proj-b', `${UUID_B}.jsonl`),
    claudeSession('/work/proj-b', UUID_B, [`${LESSON}。`]),
  );
  return ['proj-a', 'proj-b'];
}

import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collect } from '../../src/signals/collect.js';
import { createExcludePolicy } from '../../src/signals/exclude.js';
import { sessionRefFor } from '../../src/signals/ids.js';
import { signalsDir } from '../../src/signals/state-store.js';
import type { Redactor } from '../../src/contracts/redact.js';
import { SignalSchema } from '../../src/contracts/signal.js';
import { createRedactor } from '../../src/redact/index.js';
import { exists, lstat, readDir, readText, realpath } from '../../src/io/read-fs.js';
import { chmod, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import type { SessionSpec } from '../fixtures/sessions/common.js';
import { ReferenceClaudeReader } from '../fixtures/sessions/reference-reader.js';
import {
  allFilesText,
  failClosedSeed,
  homeSnapshot,
  newWork,
  recognizedSeeds,
  runCollect,
  selftestOverlayToml,
  writeOverlay,
} from './helpers.js';
import type { Work } from './helpers.js';

let homeBefore = '';
beforeAll(async () => {
  homeBefore = await homeSnapshot();
});
afterAll(async () => {
  // 真实 HOME 前后无变化(命令只写 KIT_TMP / state)
  expect(await homeSnapshot()).toBe(homeBefore);
});

function spec(w: Work, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 's1',
    userTexts: ['你好,帮我看看这个'],
    toolCalls: 2,
    failedResults: 1,
    version: '2.1.294',
    ...over,
  };
}

function parseOut(out: string): {
  report: Record<string, unknown> & {
    sessions_read: number;
    sessions_skipped_excluded: number;
    signals_emitted: number;
    signals_dropped_redaction: number;
    events: number;
  };
  sessions: { session_ref: string; counts: Record<string, unknown> }[];
  samples: string[];
  salt: string;
  written?: number;
  deduplicated?: number;
} {
  return JSON.parse(out) as ReturnType<typeof parseOut>;
}

async function stateSignals(w: Work, agent: 'claude' = 'claude') {
  const dir = signalsDir(w.io, agent);
  if (!(await exists(dir))) return [];
  const rows = [];
  for (const e of await readDir(dir)) {
    const text = await readText(path.join(dir, e.name));
    for (const line of text.split('\n')) if (line) rows.push(SignalSchema.parse(JSON.parse(line)));
  }
  return rows;
}

const ARGS = (w: Work, extra: string[] = []): string[] => [
  '--source',
  w.sessions,
  '--agent',
  'claude',
  ...extra,
];

describe('默认拒绝(决策 ③A)', () => {
  it('既无 exclude_dirs 的 overlay 也无 --allow-project:退出 2,不读不写;给了 allow-project 才跑(正向对照)', async () => {
    const w = await newWork('co-refuse-');
    await genClaude(w.io, spec(w));
    const refused = await runCollect(w, ARGS(w));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('默认拒绝');
    expect(refused.out).toBe('');
    expect(await exists(w.state)).toBe(false);

    const ok = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(ok.code).toBe(0);
    expect(parseOut(ok.out).report.signals_emitted).toBeGreaterThan(0);
  });

  it('overlay 存在但 exclude_dirs 缺失/为空 → 仍拒绝;非空 exclude_dirs → 放行', async () => {
    const w = await newWork('co-refuse2-');
    await genClaude(w.io, spec(w));
    const noExclude = await writeOverlay(w, selftestOverlayToml());
    expect((await runCollect(w, ARGS(w), { overlayPath: noExclude })).code).toBe(2);
    const empty = await writeOverlay(w, selftestOverlayToml('exclude_dirs = []'));
    expect((await runCollect(w, ARGS(w), { overlayPath: empty })).code).toBe(2);
    const full = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    expect((await runCollect(w, ARGS(w), { overlayPath: full })).code).toBe(0);
  });

  it('用法错误一律退出 2;未接入 reader 的 agent 退出 4', async () => {
    const w = await newWork('co-usage-');
    const allow = ['--allow-project', 'proj-a'];
    expect((await runCollect(w, ['--agent', 'claude', ...allow])).code).toBe(2); // 缺 --source
    expect((await runCollect(w, ['--source', w.sessions, ...allow])).code).toBe(2); // 缺 --agent
    expect((await runCollect(w, ARGS(w, ['--bogus', ...allow]))).code).toBe(2);
    expect((await runCollect(w, ARGS(w, ['--max-event-bytes', 'x', ...allow]))).code).toBe(2);
    expect((await runCollect(w, ['--source', w.sessions, '--agent', 'nope', ...allow])).code).toBe(
      2,
    );
    const badOverlay = await writeOverlay(w, 'exclude_dirs = 7');
    expect((await runCollect(w, ARGS(w), { overlayPath: badOverlay })).code).toBe(2);
    expect((await runCollect(w, ['--source', w.sessions, '--agent', 'codex', ...allow])).code).toBe(
      4,
    );
    // source 不存在 → 2
    expect(
      (await runCollect(w, ['--source', path.join(w.dir, 'nope'), '--agent', 'claude', ...allow]))
        .code,
    ).toBe(2);
  });
});

describe('脱敏端到端(A3/A6:种子秘密 0 命中)', () => {
  it('种子集经 collect 管线后,.state/signals 全部文件对种子秘密零命中;复扫干净', async () => {
    const w = await newWork('co-redact-');
    const seeds = recognizedSeeds();
    expect(seeds.length).toBeGreaterThanOrEqual(20); // 防止种子集过滤后静默变空
    const g = await genClaude(
      w.io,
      spec(w, {
        userTexts: seeds.map((s) => `看一下这个: ${s.input} 谢谢`),
        toolCalls: 1,
        failedResults: 0,
        toolInput: `export TOKEN=${seeds[0]?.input ?? ''}`,
      }),
    );
    // 正向对照 1:会话原文里确实有这些秘密(检测器不是在扫一个本来就干净的东西)
    const raw = (await readText(g.file))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const o = JSON.parse(l) as { message?: { content?: unknown } };
        return typeof o.message?.content === 'string' ? o.message.content : '';
      })
      .join('\n'); // 解码后的用户消息原文(JSON 转义会让含换行的秘密对不上字面量)
    const leaked = (text: string) =>
      seeds.filter((s) => s.needles.some((n) => text.includes(n))).map((s) => s.id);
    expect(leaked(raw).length).toBe(seeds.length);

    const overlay = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    const r = await runCollect(w, ARGS(w), { overlayPath: overlay });
    expect(r.code, r.err).toBe(0);
    const files = await allFilesText(w.state);
    // 正向对照 2:确实落了盘,且有非空摘录
    const rows = await stateSignals(w);
    expect(rows.length).toBe(seeds.length + 1);
    expect(rows.filter((x) => x.excerpt_redacted !== '').length).toBe(rows.length);
    expect(files.length).toBeGreaterThanOrEqual(2); // salt + 一个月份文件
    // 主断言:零命中(含 stdout)
    for (const f of files) expect(leaked(f.text), f.file).toEqual([]);
    expect(leaked(rows.map((x) => x.excerpt_redacted).join('\n'))).toEqual([]); // 解码后同样零命中
    expect(leaked(r.out)).toEqual([]);
    // 全部摘录二次复扫干净
    const redactor = createRedactor({ sensitive_words: ['张三科技', 'Acme Corp', '北极星计划'] });
    for (const row of rows)
      expect(redactor.pass2(row.excerpt_redacted).clean, row.sig_id).toBe(true);
    // 摘录 ≤300 码点
    for (const row of rows)
      expect(Array.from(row.excerpt_redacted).length).toBeLessThanOrEqual(300);
  });

  it('变异对照:换成「什么都不做」的脱敏器,同一套扫描会检出泄漏(证明扫描器有牙)', async () => {
    const w = await newWork('co-leak-');
    // 短种子(摘录 300 码点内放得下),逐颗断言「关掉脱敏就会泄漏」,证明每颗种子都能到达落盘处
    const seeds = recognizedSeeds()
      .filter((s) => Array.from(s.input).length <= 250)
      .slice(0, 40);
    expect(seeds.length).toBeGreaterThanOrEqual(20);
    await genClaude(
      w.io,
      spec(w, { userTexts: seeds.map((s) => s.input), toolCalls: 0, failedResults: 0 }),
    );
    const passthrough: Redactor = {
      pass1: (t) => ({ text: t, hits: [] }),
      pass2: () => ({ clean: true, hits: [] }),
      apply: (t) => ({ ok: true, text: t }),
    };
    const policy = await createExcludePolicy({ excludeDirs: [], allowProjects: ['proj-a'] });
    const out = await collect({
      reader: new ReferenceClaudeReader(),
      source: w.sessions,
      io: w.io,
      dry: false,
      redactor: passthrough,
      policy,
      salt: 'd'.repeat(64),
      fallbackVersion: undefined,
      maxEventBytes: undefined,
    });
    expect(out.report.signals_emitted).toBe(seeds.length);
    const rows = await stateSignals(w);
    const decoded = rows.map((x) => x.excerpt_redacted).join('\n');
    const missed = seeds
      .filter((s) => !s.needles.some((n) => decoded.includes(n)))
      .map((s) => s.id);
    expect(missed).toEqual([]);
  });
});

describe('失败路径:fail-closed(退出 3)', () => {
  it('第二遍才抓得到的种子 → 丢整条、退出 3、其秘密不出现在任何输出;同会话的干净信号照常写出', async () => {
    const w = await newWork('co-fail-');
    const bad = failClosedSeed();
    await genClaude(
      w.io,
      spec(w, {
        userTexts: ['干净的一条', `带坏东西 ${bad.input} 结束`],
        toolCalls: 0,
        failedResults: 0,
      }),
    );
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(r.code).toBe(3);
    expect(r.err).toContain('REDACT_FAIL_CLOSED');
    const o = parseOut(r.out);
    expect(o.report.signals_dropped_redaction).toBe(1);
    expect(o.report.signals_emitted).toBe(1);
    const everything = [r.out, r.err, ...(await allFilesText(w.state)).map((f) => f.text)].join(
      '\n',
    );
    for (const n of bad.needles) expect(everything.includes(n)).toBe(false);
    const rows = await stateSignals(w);
    expect(rows.map((x) => x.excerpt_redacted)).toEqual(['干净的一条']);
  });

  it('正向对照:没有坏种子时同一会话退出 0、两条都写出', async () => {
    const w = await newWork('co-fail-ctl-');
    await genClaude(
      w.io,
      spec(w, { userTexts: ['干净的一条', '另一条'], toolCalls: 0, failedResults: 0 }),
    );
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(r.code).toBe(0);
    expect((await stateSignals(w)).length).toBe(2);
  });

  it('注入脱敏器的 error / timeout 同样丢整条并计数(reason 分类)', async () => {
    for (const reason of ['error', 'timeout'] as const) {
      const w = await newWork(`co-inj-${reason}-`);
      await genClaude(w.io, spec(w, { userTexts: ['a', 'b'], toolCalls: 0, failedResults: 0 }));
      const failing: Redactor = {
        pass1: (t) => ({ text: t, hits: [] }),
        pass2: () => ({ clean: false, hits: [] }),
        apply: () => ({ ok: false, reason }),
      };
      const out = await collect({
        reader: new ReferenceClaudeReader(),
        source: w.sessions,
        io: w.io,
        dry: false,
        redactor: failing,
        policy: await createExcludePolicy({ excludeDirs: [], allowProjects: ['proj-a'] }),
        salt: 'e'.repeat(64),
        fallbackVersion: undefined,
        maxEventBytes: undefined,
      });
      expect(out.report.signals_dropped_redaction).toBe(2);
      expect(out.report.signals_emitted).toBe(0);
      expect(out.dropReasons[reason]).toBe(2);
      expect(out.write?.written).toBe(0);
      expect(await exists(signalsDir(w.io, 'claude'))).toBe(false);
    }
  });

  it('盐文件损坏:系统性错误,整次中止,退出 3,不写任何信号', async () => {
    const w = await newWork('co-badsalt-');
    await genClaude(w.io, spec(w));
    expect((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).code).toBe(0);
    await writeFile(w.io, path.join(w.state, 'salt'), 'garbage\n', { mode: 0o600 });
    const before = await allFilesText(path.join(w.state, 'signals'));
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(r.code).toBe(3);
    expect(r.out).toBe('');
    expect(await allFilesText(path.join(w.state, 'signals'))).toEqual(before);
  });
});

describe('排除清单生效(整条跳过,不是仅脱敏)', () => {
  it('被排除目录的会话没有任何信号落盘;未排除的会话落盘(正向对照)', async () => {
    const w = await newWork('co-excl-');
    const client = await genClaude(
      w.io,
      spec(w, { id: 'client', cwd: '/clients/acme/app', userTexts: ['客户的话'] }),
    );
    const mine = await genClaude(
      w.io,
      spec(w, { id: 'mine', cwd: '/work/proj-a', userTexts: ['我的话'] }),
    );
    const overlay = await writeOverlay(w, selftestOverlayToml('exclude_dirs = ["/clients/acme"]'));
    const r = await runCollect(w, ARGS(w), { overlayPath: overlay });
    expect(r.code).toBe(0);
    const o = parseOut(r.out);
    expect(o.report.sessions_skipped_excluded).toBe(1);
    expect(o.report.sessions_read).toBe(1);
    const salt = (await readText(path.join(w.state, 'salt'))).trim();
    const clientRef = sessionRefFor(salt, client.file);
    const mineRef = sessionRefFor(salt, mine.file);
    const rows = await stateSignals(w);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.session_ref === mineRef)).toBe(true);
    const all = [r.out, ...(await allFilesText(w.state)).map((f) => f.text)].join('\n');
    expect(all.includes(clientRef)).toBe(false);
    expect(all.includes('客户的话')).toBe(false);
    expect(o.sessions.map((s) => s.session_ref)).toEqual([mineRef]);

    // 正向对照:不排除时,客户会话同样会落盘(说明上面的「没有」是排除造成的)
    const w2 = await newWork('co-excl-ctl-');
    const client2 = await genClaude(
      w2.io,
      spec(w2, { id: 'client', cwd: '/clients/acme/app', userTexts: ['客户的话'] }),
    );
    const overlay2 = await writeOverlay(
      w2,
      selftestOverlayToml('exclude_dirs = ["/somewhere/else"]'),
    );
    const r2 = await runCollect(w2, ARGS(w2), { overlayPath: overlay2 });
    expect(r2.code).toBe(0);
    const salt2 = (await readText(path.join(w2.state, 'salt'))).trim();
    expect(
      (await stateSignals(w2)).every((x) => x.session_ref === sessionRefFor(salt2, client2.file)),
    ).toBe(true);
    expect((await stateSignals(w2)).length).toBeGreaterThan(0);
  });

  it('allow-project 白名单:不在名单内的项目整条跳过', async () => {
    const w = await newWork('co-allow-');
    await genClaude(w.io, spec(w, { id: 'a', cwd: '/work/proj-a' }));
    await genClaude(w.io, spec(w, { id: 'b', cwd: '/work/proj-b' }));
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-b']));
    const o = parseOut(r.out);
    expect(o.report.sessions_read).toBe(1);
    expect(o.report.sessions_skipped_excluded).toBe(1);
  });

  it('会话没有 cwd:保守跳过(无法证明不在排除目录里)', async () => {
    const w = await newWork('co-nocwd-');
    await genClaude(w.io, spec(w));
    const g = await genClaude(w.io, spec(w, { id: 'nocwd', cwd: '/work/proj-a' }));
    const text = (await readText(g.file)).replaceAll('"cwd":"/work/proj-a",', '');
    await writeFile(w.io, g.file, text);
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    const o = parseOut(r.out);
    expect(o.report.sessions_read).toBe(1);
    expect(o.report.sessions_skipped_excluded).toBe(1);
  });
});

describe('外部内容会话:摘录为空,只保留结构化信息', () => {
  it('WebFetch 会话的全部信号 excerpt 为空且 external_content=true;本地工具会话不受影响(正向对照)', async () => {
    const w = await newWork('co-ext-');
    await genClaude(
      w.io,
      spec(w, { id: 'ext', toolName: 'WebFetch', userTexts: ['外部会话的话'] }),
    );
    await genClaude(
      w.io,
      spec(w, { id: 'loc', cwd: '/work/proj-a2', toolName: 'Bash', userTexts: ['本地会话的话'] }),
    );
    const r = await runCollect(
      w,
      ARGS(w, ['--allow-project', 'proj-a', '--allow-project', 'proj-a2']),
    );
    expect(r.code).toBe(0);
    const rows = await stateSignals(w);
    const ext = rows.filter((x) => x.external_content);
    const loc = rows.filter((x) => !x.external_content);
    expect(ext.length).toBeGreaterThan(0);
    expect(loc.length).toBeGreaterThan(0);
    expect(ext.every((x) => x.excerpt_redacted === '')).toBe(true);
    expect(loc.some((x) => x.excerpt_redacted.includes('本地会话的话'))).toBe(true);
    const text = (await allFilesText(w.state)).map((f) => f.text).join('\n');
    expect(text.includes('外部会话的话')).toBe(false);
  });
});

describe('--dry', () => {
  it('不落盘(state 目录都不创建),stdout 有报告/逐会话计数/≤5 条脱敏样例(正向对照:非 dry 才落盘)', async () => {
    const w = await newWork('co-dry-');
    const g = await genClaude(
      w.io,
      spec(w, {
        userTexts: ['一', '二', '三', '四', '五', '六', '七'],
        unknownEvent: true,
        malformedLine: true,
      }),
    );
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a', '--dry']));
    expect(r.code).toBe(0);
    expect(await exists(w.state)).toBe(false);
    const o = parseOut(r.out);
    expect(o.salt).toBe('ephemeral');
    expect(o.report.signals_emitted).toBeGreaterThan(5);
    expect(o.samples.length).toBe(5);
    for (const s of o.samples) expect(Array.from(s).length).toBeLessThanOrEqual(300);
    expect(o.sessions).toHaveLength(1);
    expect(o.sessions[0]?.counts).toMatchObject({
      user_messages: g.expected.user_messages,
      tool_calls: g.expected.tool_calls,
      tool_failures: g.expected.tool_failures,
      unknown_event_types: g.expected.unknown_event_types,
    });
    expect(r.out.includes(g.file)).toBe(false); // 路径不进输出

    const real = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(real.code).toBe(0);
    expect(await exists(w.state)).toBe(true);
    expect(parseOut(real.out).salt).toBe('persisted');
  });

  it('dry 与真跑:已有盐时 session_ref 一致(oracle 可对拍)', async () => {
    const w = await newWork('co-dry2-');
    await genClaude(w.io, spec(w));
    const real = parseOut((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).out);
    const dry = parseOut(
      (await runCollect(w, ARGS(w, ['--allow-project', 'proj-a', '--dry']))).out,
    );
    expect(dry.salt).toBe('persisted');
    expect(dry.sessions).toEqual(real.sessions);
  });
});

describe('超长行 / 幂等 / 只读源', () => {
  it('超长行不改变逐会话计数;报告里 oversized_lines 只在紧的 maxEventBytes 下 >0', async () => {
    const w = await newWork('co-big-');
    await genClaude(
      w.io,
      spec(w, { userTexts: ['短', 'Q'.repeat(6000), '尾'], malformedLine: true }),
    );
    const allow = ['--allow-project', 'proj-a', '--dry'];
    const roomy = parseOut((await runCollect(w, ARGS(w, allow))).out);
    const tight = parseOut(
      (await runCollect(w, ARGS(w, [...allow, '--max-event-bytes', '1000']))).out,
    );
    expect(roomy.report.oversized_lines).toBe(0);
    expect(tight.report.oversized_lines).toBe(1);
    const strip = (o: typeof roomy) => o.sessions.map((s) => ({ ...s.counts, oversized_lines: 0 }));
    expect(strip(tight)).toEqual(strip(roomy));
    expect(tight.report.unknown_event_types).toEqual({ '<malformed>': 1 });
  });

  it('重跑幂等:第二次不新增行,sig_id 稳定', async () => {
    const w = await newWork('co-idem-');
    await genClaude(w.io, spec(w));
    const a = parseOut((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).out);
    const idsA = (await stateSignals(w)).map((x) => x.sig_id);
    const b = parseOut((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).out);
    expect(a.written).toBeGreaterThan(0);
    expect(b.written).toBe(0);
    expect(b.deduplicated).toBe(a.written);
    expect((await stateSignals(w)).map((x) => x.sig_id)).toEqual(idsA);
    expect(new Set(idsA).size).toBe(idsA.length);
  });

  it('源目录与文件只读(0444/0555)时照常成功,且源文件字节不变', async () => {
    const w = await newWork('co-ro-');
    const g = await genClaude(w.io, spec(w));
    const dir = path.dirname(g.file);
    const before = await readText(g.file);
    await chmod(w.io, g.file, 0o444);
    await chmod(w.io, dir, 0o555);
    try {
      const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
      expect(r.code, r.err).toBe(0);
      expect(parseOut(r.out).report.signals_emitted).toBeGreaterThan(0);
      expect(await readText(g.file)).toBe(before);
      expect((await lstat(g.file)).mode & 0o777).toBe(0o444);
    } finally {
      await chmod(w.io, dir, 0o755);
      await chmod(w.io, g.file, 0o644);
    }
  });
});

describe('信号结构', () => {
  it('Signal 全字段合规;agent_version 会话内 → session_meta,缺失 → --cli-version 兜底 → collector_fallback;projectKey 为哈希', async () => {
    const w = await newWork('co-sig-');
    await genClaude(w.io, spec(w, { id: 'withver', cwd: '/work/proj-a', version: '2.1.294' }));
    await genClaude(w.io, spec(w, { id: 'nover', cwd: '/work/proj-a2', version: undefined }));
    const r = await runCollect(
      w,
      ARGS(w, [
        '--allow-project',
        'proj-a',
        '--allow-project',
        'proj-a2',
        '--cli-version',
        'claude 9.8.7 (x)',
      ]),
    );
    expect(r.code).toBe(0);
    const rows = await stateSignals(w);
    const kinds = new Set(rows.map((x) => `${x.agent_version}|${x.agent_version_source}`));
    expect(kinds).toEqual(new Set(['2.1.294|session_meta', '9.8.7|collector_fallback']));
    for (const x of rows) {
      expect(x.project_key).toMatch(/^p_[0-9a-f]{16}$/);
      expect(x.type).toBe('event');
      expect(x.loaded_rule_ids).toEqual([]);
    }
    expect(parseOut(r.out).report.agent_version_fallback_ratio).toBe(0.5);
    // 项目名/路径不在任何落盘产物里
    const text = (await allFilesText(w.state)).map((f) => f.text).join('\n');
    expect(text.includes('proj-a')).toBe(false);
    expect(text.includes('/work/')).toBe(false);
  });
});

describe('补充:键清洗 / 符号链接 / 空文件 / 库损坏 / 只读对照', () => {
  it('未知事件类型名里藏秘密:报告与逐会话计数里归并到 <unprintable>,秘密不出现在 stdout', async () => {
    const w = await newWork('co-key-');
    const seed = recognizedSeeds().find(
      (x) => /^[\x21-\x7e]+$/.test(x.input) && x.input.length < 90,
    );
    expect(seed).toBeDefined();
    const g = await genClaude(w.io, spec(w, { userTexts: ['x'], toolCalls: 0, failedResults: 0 }));
    const prev = await readText(g.file);
    await writeFile(
      w.io,
      g.file,
      `${prev}${JSON.stringify({ type: seed?.input })}\n${JSON.stringify({ type: 'weird-new-type' })}\n`,
    );
    const r = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a', '--dry']));
    expect(r.code).toBe(0);
    const o = parseOut(r.out);
    const unknown = o.report['unknown_event_types'] as Record<string, number>;
    expect(unknown['weird-new-type']).toBe(1); // 正向对照:正常的键原样保留
    expect(unknown['<unprintable>']).toBe(1);
    for (const n of seed?.needles ?? []) expect(r.out.includes(n)).toBe(false);
  });

  it('source 经符号链接传入:session_ref 与真实路径一致(realpath 归一);项目目录的符号链接别名得到同一 project_key', async () => {
    const w = await newWork('co-symlink-');
    const real = path.join(w.dir, 'real-proj');
    await mkdirp(w.io, real);
    const alias = path.join(w.dir, 'alias-proj');
    await symlink(w.io, real, alias);
    const g1 = await genClaude(w.io, spec(w, { id: 'viareal', cwd: real, userTexts: ['甲'] }));
    const g2 = await genClaude(w.io, spec(w, { id: 'viaalias', cwd: alias, userTexts: ['乙'] }));
    const link = path.join(w.dir, 'sessions-link');
    await symlink(w.io, w.sessions, link);
    const r = await runCollect(w, ['--source', link, '--agent', 'claude', '--allow-project', real]);
    expect(r.code, r.err).toBe(0);
    const rows = await stateSignals(w);
    const salt = (await readText(path.join(w.state, 'salt'))).trim();
    const expected = new Set([
      sessionRefFor(salt, await realpath(g1.file)),
      sessionRefFor(salt, await realpath(g2.file)),
    ]);
    expect(new Set(rows.map((x) => x.session_ref))).toEqual(expected);
    expect(new Set(rows.map((x) => x.project_key)).size).toBe(1);
  });

  it('空文件 / 只有 BOM 与空白行的会话:计数全 0、无事件;限制模式下因无 cwd 被跳过', async () => {
    const w = await newWork('co-empty-');
    const g = await genClaude(w.io, spec(w, { id: 'empty' }));
    await writeFile(w.io, g.file, '');
    const r1 = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a', '--dry']));
    expect(r1.code).toBe(0);
    expect(parseOut(r1.out).report.sessions_skipped_excluded).toBe(1);
    await writeFile(w.io, g.file, '\uFEFF\n   \n\r\n');
    const r2 = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a', '--dry']));
    expect(r2.code).toBe(0);
    expect(parseOut(r2.out).report.signals_emitted).toBe(0);
  });

  it('信号库有坏行 → fail-closed 退出 3,库不被改动(正向对照:修好后可继续)', async () => {
    const w = await newWork('co-corrupt-');
    await genClaude(w.io, spec(w));
    expect((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).code).toBe(0);
    const dir = signalsDir(w.io, 'claude');
    const file = path.join(dir, (await readDir(dir))[0]?.name ?? '');
    const good = await readText(file);
    await genClaude(w.io, spec(w, { id: 'second', userTexts: ['新的一条'] }));
    await writeFile(w.io, file, `${good}{broken\n`, { mode: 0o600 });
    const bad = await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']));
    expect(bad.code).toBe(3);
    expect(await readText(file)).toBe(`${good}{broken\n`);
    await writeFile(w.io, file, good, { mode: 0o600 });
    expect((await runCollect(w, ARGS(w, ['--allow-project', 'proj-a']))).code).toBe(0);
  });

  it('超长行事件仍产出信号(摘录为空);其余信号摘录正常', async () => {
    const w = await newWork('co-bigsig-');
    await genClaude(
      w.io,
      spec(w, { userTexts: ['短', 'Q'.repeat(6000)], toolCalls: 0, failedResults: 0 }),
    );
    const r = await runCollect(
      w,
      ARGS(w, ['--allow-project', 'proj-a', '--max-event-bytes', '1000']),
    );
    expect(r.code).toBe(0);
    const rows = await stateSignals(w);
    expect(rows.map((x) => x.excerpt_redacted).sort()).toEqual(['', '短']);
  });

  it('只读证明的对照:同一目录在 0555 下写入确实会失败(否则只读断言是空话);root 下跳过', async () => {
    const w = await newWork('co-rocontrol-');
    const dir = path.join(w.dir, 'locked');
    await mkdirp(w.io, dir);
    await chmod(w.io, dir, 0o555);
    try {
      if (process.getuid?.() === 0) return;
      await expect(writeFile(w.io, path.join(dir, 'x.txt'), 'x')).rejects.toThrow();
    } finally {
      await chmod(w.io, dir, 0o755);
    }
  });
});

/**
 * N4 ⑥:`judge --ingest` / `--confirm-reflector` 命令入口(独立文件 `src/commands/judge-ingest.ts`;R20-18.3、R20-18.5、R20-18.22)。
 * 终端 / stdin 都是注入的;TTY 门先于一切读取;stdout 只有 `--json` 结果;stderr 只有稳定码。
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli.js';
import { createJudgeIngestCommand, parseIngestArgs } from '../../../src/commands/judge-ingest.js';
import type { CommandContext, StdinRead } from '../../../src/commands/types.js';
import { CANARY, FROZEN_NOW, VALID_OUTPUT, newWork, redactor, snapshot } from '../helpers.js';
import type { Work } from '../helpers.js';
import { FakeTty, payloadText, writeSessionProposal } from './fixtures.js';

describe('parseIngestArgs', () => {
  const err = (argv: string[]) => parseIngestArgs(argv).error;
  it('合法形状', () => {
    expect(parseIngestArgs(['--ingest', '-', '--run', 'run-0001'])).toMatchObject({
      mode: 'ingest',
      run: 'run-0001',
      write: false,
      error: undefined,
    });
    expect(
      parseIngestArgs(['--ingest', '-', '--run=run-0001', '--write', '--replace', '--json']),
    ).toMatchObject({ write: true, replace: true, json: true, error: undefined });
    expect(
      parseIngestArgs([
        '--confirm-reflector',
        '--run',
        'r1',
        '--proposal',
        'a',
        '--proposal',
        'b',
        '--write',
      ]),
    ).toMatchObject({ mode: 'confirm_reflector', proposals: ['a', 'b'], error: undefined });
  });
  it('精确的用法错误码', () => {
    expect(err(['--ingest', '-', '--run', 'r1', '--bogus'])).toBe('unknown_arg');
    expect(err(['--ingest', 'file.json', '--run', 'r1'])).toBe('unknown_arg'); // 只接受 - = stdin
    expect(err(['--ingest', '--run', 'r1'])).toBe('unknown_arg');
    expect(err(['--ingest', '-', '--confirm-reflector', '--run', 'r1', '--write'])).toBe(
      'mode_conflict',
    );
    for (const f of ['--run-llm', '--allow-egress', '--strict', '--max-calls=3']) {
      expect(err(['--ingest', '-', '--run', 'r1', f]), f).toBe('mode_conflict');
    }
    expect(err(['--ingest', '-', '--run', 'r1', '--max-calls', '3'])).toBe('mode_conflict'); // 值被吞掉,不报 unknown_arg
    expect(err(['--ingest', '-', '--run', 'r1', '--replace'])).toBe('mode_conflict'); // --replace 只与 --ingest --write 同用
    expect(err(['--confirm-reflector', '--run', 'r1', '--write', '--replace'])).toBe(
      'mode_conflict',
    );
    expect(err(['--ingest', '-', '--run', 'r1', '--proposal', 'a'])).toBe('mode_conflict'); // --proposal 只与 --confirm-reflector 同用
    expect(err(['--ingest', '-'])).toBe('missing:--run');
    expect(err(['--confirm-reflector', '--run', 'r1'])).toBe('write_required');
    expect(err(['--ingest', '-', '--run', '../x'])).toBe('bad_run');
    // 优先级:unknown_arg > mode_conflict > missing:--run
    expect(err(['--ingest', '-', '--confirm-reflector', '--bogus'])).toBe('unknown_arg');
    expect(err(['--ingest', '-', '--confirm-reflector'])).toBe('mode_conflict');
  });
});

interface Harness {
  w: Work;
  tty: FakeTty;
  out: string[];
  err: string[];
  stdinReads: number[];
  run(
    argv: string[],
    stdin?: StdinRead | Error,
    ttyOpen?: boolean,
    stdinIsTty?: boolean,
  ): Promise<number>;
}

async function harness(input: string[] = []): Promise<Harness> {
  const w = await newWork();
  const tty = new FakeTty(input);
  const out: string[] = [];
  const err: string[] = [];
  const stdinReads: number[] = [];
  const h: Harness = {
    w,
    tty,
    out,
    err,
    stdinReads,
    async run(argv, stdin = { text: '', tooLarge: false }, ttyOpen = true, stdinIsTty = false) {
      const port = ttyOpen ? tty : Object.assign(Object.create(tty), { open: () => undefined });
      const cmd = createJudgeIngestCommand({
        tty: port,
        stdinIsTty: () => stdinIsTty,
        redactor,
        now: () => FROZEN_NOW,
        resolveHead: () => w.head,
      });
      const ctx: CommandContext = {
        argv,
        io: w.io,
        overlayPath: undefined,
        env: { HOME: w.dir, KIT_TMP: w.dir, KIT_STATE_DIR: w.state, PATH: '/usr/bin:/bin' },
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        readStdin: async (n) => {
          stdinReads.push(n);
          if (stdin instanceof Error) throw stdin;
          return stdin;
        },
      };
      return cmd.run(ctx);
    },
  };
  return h;
}

const stdinOf = (text: string): StdinRead => ({ text, tooLarge: false });

describe('TTY 门(R20-18.5)', () => {
  it('--write 且打不开控制终端 → 退出 2 JUDGE_USAGE reason=not_tty;stdin 未读、暂存区字节不变;干跑在无 TTY 下可跑', async () => {
    const h = await harness();
    const a = await writeSessionProposal(h.w, { layer: 'personal', target: 'p-rule' });
    const text = payloadText([{ id: a.id, rule_sha256: a.ruleSha }]);
    const before = await snapshot(h.w.runDir);
    const code = await h.run(
      ['--ingest', '-', '--run', 'run-0001', '--write'],
      stdinOf(text),
      false,
    );
    expect(code).toBe(2);
    expect(h.err.join('')).toBe('JUDGE_USAGE reason=not_tty\n');
    expect(h.stdinReads).toEqual([]);
    expect(h.out).toEqual([]);
    expect(await snapshot(h.w.runDir)).toEqual(before);
    // 正向对照:同一 payload 干跑(无 --write)在无 TTY 下通过
    const dry = await h.run(['--ingest', '-', '--run', 'run-0001', '--json'], stdinOf(text), false);
    expect(dry).toBe(0);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ result: 'dry', reason: null });
  });
  it('--ingest 的 stdin 是 TTY → 退出 2 stdin_is_tty;未读 stdin、终端句柄已关;--confirm-reflector 不受此约束', async () => {
    const h = await harness();
    await writeSessionProposal(h.w, { layer: 'team' });
    expect(
      await h.run(['--ingest', '-', '--run', 'run-0001', '--write'], stdinOf('{}'), true, true),
    ).toBe(2);
    expect(h.err.join('')).toBe('JUDGE_USAGE reason=stdin_is_tty\n');
    expect(h.stdinReads).toEqual([]);
    expect(h.tty.closed).toBe(1);
    h.err.length = 0;
    h.tty.input = ['anthropic', 'claude-example'];
    expect(
      await h.run(['--confirm-reflector', '--run', 'run-0001', '--write'], stdinOf(''), true, true),
    ).toBe(0);
    expect(h.stdinReads).toEqual([]); // confirm-reflector 不读 stdin
  });
  it('用法错误:精确码,退出 2,不碰终端', async () => {
    const h = await harness();
    for (const [argv, reason] of [
      [['--confirm-reflector', '--run', 'run-0001'], 'write_required'],
      [['--ingest', '-'], 'missing:--run'],
      [['--ingest', '-', '--confirm-reflector', '--run', 'run-0001', '--write'], 'mode_conflict'],
    ] as const) {
      h.err.length = 0;
      expect(await h.run([...argv])).toBe(2);
      expect(h.err.join('')).toBe(`JUDGE_USAGE reason=${reason}\n`);
    }
    expect(h.tty.opened).toBe(0);
  });
  it('run 不存在 → JUDGE_USAGE bad_run(退出 2)', async () => {
    const h = await harness();
    expect(
      await h.run(
        ['--ingest', '-', '--run', 'run-9999'],
        stdinOf(
          payloadText([{ id: '2026-10-12-001', rule_sha256: 'a'.repeat(64) }], {
            run_id: 'run-9999',
          }),
        ),
      ),
    ).toBe(2);
    expect(h.err.join('')).toBe('JUDGE_USAGE reason=bad_run\n');
  });
});

describe('输出通道与退出码(R20-18.22)', () => {
  it('--write --json:stdout 只有固定键集合的 JSON;确认屏全在终端句柄;stderr 为空;退出 0', async () => {
    const h = await harness(['openai']);
    const a = await writeSessionProposal(h.w, { layer: 'personal', target: 'p-rule' });
    const code = await h.run(
      ['--ingest', '-', '--run', 'run-0001', '--write', '--json'],
      stdinOf(payloadText([{ id: a.id, rule_sha256: a.ruleSha }])),
    );
    expect(code).toBe(0);
    expect(h.err).toEqual([]);
    const doc = JSON.parse(h.out.join('')) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual([
      'proposals',
      'reason',
      'reflector_confirmed',
      'replaced',
      'result',
      'run_id',
      'written',
    ]);
    expect(doc).toMatchObject({
      result: 'written',
      reason: null,
      run_id: 'run-0001',
      proposals: [a.id],
      reflector_confirmed: [],
      written: 1,
      replaced: 0,
    });
    expect(h.tty.screen).toContain('declared agent=codex');
    expect(h.out.join('')).not.toContain('declared agent');
    expect(h.tty.opened).toBe(1);
    expect(h.tty.closed).toBe(1);
  });
  it('放弃 → 退出 1 JUDGE_CONFIRM_DECLINED;用户键入的内容不出现在 stdout / stderr', async () => {
    const SECRET = 'zzqq-typed-secret';
    const h = await harness([SECRET]);
    const a = await writeSessionProposal(h.w, { layer: 'personal', target: 'p-rule' });
    const before = await snapshot(h.w.runDir);
    const code = await h.run(
      ['--ingest', '-', '--run', 'run-0001', '--write', '--json'],
      stdinOf(payloadText([{ id: a.id, rule_sha256: a.ruleSha }])),
    );
    expect(code).toBe(1);
    expect(h.err.join('')).toBe('JUDGE_CONFIRM_DECLINED reason=invalid\n');
    expect(JSON.parse(h.out.join(''))).toMatchObject({ result: 'declined', reason: 'invalid' });
    expect(h.out.join('') + h.err.join('')).not.toContain(SECRET);
    expect(await snapshot(h.w.runDir)).toEqual(before);
  });
  it('校验拒绝 → 退出 1 JUDGE_INGEST_REJECTED reason=<子码>;stderr 不回显 payload / 异常文本', async () => {
    const h = await harness();
    const a = await writeSessionProposal(h.w, { layer: 'personal', target: 'p-rule' });
    const code = await h.run(
      ['--ingest', '-', '--run', 'run-0001'],
      stdinOf(
        payloadText([
          {
            id: a.id,
            rule_sha256: '0'.repeat(64),
            output: { ...VALID_OUTPUT, notes: CANARY.rationale },
          },
        ]),
      ),
    );
    expect(code).toBe(1);
    expect(h.err.join('')).toBe('JUDGE_INGEST_REJECTED reason=rule_hash_mismatch\n');
    expect(h.err.join('') + h.out.join('')).not.toContain(CANARY.rationale);
  });
  it('stdin 超限 → 退出 1 input_too_large(不拿锁);stdin 读流出错 → 退出 3 stdin_unreadable', async () => {
    const h = await harness();
    await writeSessionProposal(h.w, { layer: 'personal', target: 'p-rule' });
    expect(await h.run(['--ingest', '-', '--run', 'run-0001'], { text: '', tooLarge: true })).toBe(
      1,
    );
    expect(h.err.join('')).toBe('JUDGE_INGEST_REJECTED reason=input_too_large\n');
    h.err.length = 0;
    expect(await h.run(['--ingest', '-', '--run', 'run-0001'], new Error('EIO'))).toBe(3);
    expect(h.err.join('')).toBe('JUDGE_FAIL_CLOSED reason=stdin_unreadable\n');
  });
  it('--confirm-reflector 无候选 → 退出 0 nothing_to_confirm,零写入', async () => {
    const h = await harness();
    await writeSessionProposal(h.w, { layer: 'team', provenance: 'spawned' });
    const before = await snapshot(h.w.runDir);
    expect(await h.run(['--confirm-reflector', '--run', 'run-0001', '--write'])).toBe(0);
    expect(h.out.join('')).toBe('nothing_to_confirm\n');
    expect(await snapshot(h.w.runDir)).toEqual(before);
  });
  it('干跑文本输出:每条提案一行(枚举 + freeze=deferred),不含 payload 自由文本', async () => {
    const h = await harness();
    const a = await writeSessionProposal(h.w, { layer: 'team' });
    expect(
      await h.run(
        ['--ingest', '-', '--run', 'run-0001'],
        stdinOf(payloadText([{ id: a.id, rule_sha256: a.ruleSha }])),
      ),
    ).toBe(0);
    expect(h.out.join('')).toBe(
      `dry run=run-0001\nproposal=${a.id} layer=team verdict=accept overfit=low injection=false conflicts=0 prediction=not_required reflector_confirm=required freeze=deferred\n`,
    );
  });
});

describe('cli 路由:judge 的 argv 里出现 --ingest / --confirm-reflector → 独立入口(judge.ts 的既有模式不变)', () => {
  const run = async (args: string[]) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { PATH: '/usr/bin:/bin' },
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    });
    return { code, out, err };
  };
  it('--help 展示的是入口自己的 flag 表;judge 本体不含它们', async () => {
    const ingest = await run(['judge', '--ingest', '-', '--help']);
    expect(ingest.out).toContain('--confirm-reflector');
    expect(ingest.out).toContain('--write');
    const plain = await run(['judge', '--help']);
    expect(plain.out).not.toContain('--confirm-reflector');
    expect(plain.out).toContain('--run-llm');
  });
  it('用法错误经真实路由到达入口(不需要 stdin / 终端)', async () => {
    const r = await run(['judge', '--confirm-reflector', '--run', 'run-0001']);
    expect(r.code).toBe(2);
    expect(r.err).toBe('JUDGE_USAGE reason=write_required\n');
    // 既有模式的用法错误文本不变(仍是 `agent-kit judge: …`)
    const old = await run(['judge']);
    expect(old.code).toBe(2);
    expect(old.err).toContain('agent-kit judge:');
  });
});

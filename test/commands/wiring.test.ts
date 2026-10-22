/**
 * 默认接线(真实 buildBackends + 假 CLI 二进制):证明
 *  - 干跑从不构造/调用后端;
 *  - CLI 参数集仍是 verified:false,没有 allow_unverified 就不 spawn;
 *  - allow_unverified 逐槽位生效(同一个二进制被另一个没写的槽位使用时仍被拒);
 *  - judge 的默认 command 与 reflect 走同一套工厂。
 * 假二进制只是 KIT_TMP 里的一个 shell 脚本,调用时在旁边写一个 canary 文件;不联网、不运行任何真实 LLM CLI。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { command as judgeCommand } from '../../src/commands/judge.js';
import { command as reflectCommand } from '../../src/commands/reflect.js';
import type { CommandContext } from '../../src/commands/types.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { stageDir } from '../../src/reflect/stage.js';
import { baseCtx } from '../helpers/tmp.js';
import { RUN_ID, newWork, outputText, writeProposal } from '../judge/helpers.js';
import { ctxFor, newR5World, overlayToml } from './r5-world.js';

const LIVE_R = ['--run-llm', '--allow-egress', '--owner', '@tester'];

function requireKitTmp(): void {
  // 假二进制必须放在 KIT_TMP 内(llm-exec 拒绝仓库内、且不在 KIT_TMP 内的二进制)
  if (baseCtx().tmpDir === undefined) throw new Error('这组测试需要先设置 KIT_TMP(指向仓库外)');
}

async function fakeCli(
  io: Parameters<typeof safe.writeFile>[0],
  parent: string,
  name: 'codex' | 'claude' | 'pi',
  stdoutText: string,
): Promise<{ env: Record<string, string>; canary: string }> {
  const bin = path.join(parent, 'bin');
  const home = path.join(parent, 'home');
  const canary = path.join(parent, `canary-${name}`);
  await safe.mkdirp(io, bin);
  await safe.mkdirp(io, home);
  const file = path.join(bin, name);
  await safe.writeFile(
    io,
    file,
    `#!/bin/sh\necho invoked > '${canary}'\ncat > /dev/null\nprintf '%s' '${stdoutText}'\n`,
  );
  await safe.chmod(io, file, 0o755);
  return { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, canary };
}

const BIND = (slot: string, extra = ''): string =>
  `[[reflect.backends]]\nslot = "${slot}"\ncli = "codex"\nmodel = "gpt-5.6-test"\n${extra}\n`;

describe('reflect 默认接线(真实 buildBackends + 假 codex)', () => {
  it('干跑:即使覆盖层绑了后端、同意外发,也不构造不调用(canary 不出现)', async () => {
    requireKitTmp();
    const w = await newR5World({
      overlay: overlayToml('egress = true') + BIND('codex', 'allow_unverified = true'),
    });
    const fake = await fakeCli(w.io, w.parent, 'codex', '{"proposals":[]}');
    const { ctx } = ctxFor(w, [], fake.env);
    expect(await reflectCommand.run(ctx)).toBe(ExitCode.OK);
    expect(await exists(fake.canary)).toBe(false);
    expect(await exists(stageDir(w.io, 'x'))).toBe(false);
  });

  it('真跑但没写 allow_unverified:参数集未核实 → 不 spawn,退出 4;写了 allow_unverified=true 才 spawn(正向对照)', async () => {
    requireKitTmp();
    const off = await newR5World({ overlay: overlayToml('egress = true') + BIND('codex') });
    const fakeOff = await fakeCli(off.io, off.parent, 'codex', '{"proposals":[]}');
    const a = ctxFor(off, LIVE_R, fakeOff.env);
    expect(await reflectCommand.run(a.ctx)).toBe(ExitCode.NOT_RUN);
    expect(await exists(fakeOff.canary)).toBe(false);
    expect(a.err.join('')).toContain('REFLECT_NOT_RUN reason=backend_');

    const on = await newR5World({
      overlay: overlayToml('egress = true') + BIND('codex', 'allow_unverified = true'),
    });
    const fakeOn = await fakeCli(on.io, on.parent, 'codex', '{"proposals":[]}');
    const b = ctxFor(on, [...LIVE_R, '--json'], fakeOn.env);
    expect(await reflectCommand.run(b.ctx)).toBe(ExitCode.OK);
    expect(await exists(fakeOn.canary)).toBe(true);
    const j = JSON.parse(b.out.join('')) as { calls: { made: number }; outcome: string };
    expect(j.calls.made).toBe(1);
    expect(j.outcome).toBe('no_proposals');
  });

  it('allow_unverified 逐槽位:两个槽位共用同一个 codex 二进制,没写的那个仍被拒', async () => {
    requireKitTmp();
    const overlay =
      overlayToml('egress = true') +
      BIND('codex', 'allow_unverified = true') +
      BIND('maas-deepseek');
    const w = await newR5World({ overlay });
    const fake = await fakeCli(w.io, w.parent, 'codex', '{"proposals":[]}');
    const denied = ctxFor(w, [...LIVE_R, '--backend', 'maas-deepseek'], fake.env);
    expect(await reflectCommand.run(denied.ctx)).toBe(ExitCode.NOT_RUN);
    expect(await exists(fake.canary)).toBe(false);
    const allowed = await newR5World({ overlay });
    const fake2 = await fakeCli(allowed.io, allowed.parent, 'codex', '{"proposals":[]}');
    const ok = ctxFor(allowed, [...LIVE_R, '--backend', 'codex'], fake2.env);
    expect(await reflectCommand.run(ok.ctx)).toBe(ExitCode.OK);
    expect(await exists(fake2.canary)).toBe(true);
  });

  it('allow_unverified = false 的槽位拿到的清单为空:PATH 里有二进制也不放行', async () => {
    requireKitTmp();
    const w = await newR5World({
      overlay: overlayToml('egress = true') + BIND('codex', 'allow_unverified = false'),
    });
    const fake = await fakeCli(w.io, w.parent, 'codex', '{"proposals":[]}');
    expect(await reflectCommand.run(ctxFor(w, LIVE_R, fake.env).ctx)).toBe(ExitCode.NOT_RUN);
    expect(await exists(fake.canary)).toBe(false);
  });
});

describe('judge 默认接线', () => {
  const judgeCtx = async (
    w: Awaited<ReturnType<typeof newWork>>,
    argv: string[],
    overlay: string | undefined,
    env?: Record<string, string>,
  ) => {
    let overlayPath: string | undefined;
    if (overlay !== undefined) {
      overlayPath = path.join(w.dir, 'overlay.toml');
      await safe.writeFile(w.io, overlayPath, overlay);
    }
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      argv,
      io: w.io,
      overlayPath,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      ...(env !== undefined ? { env } : {}),
    };
    return { ctx, out, err };
  };
  const LIVE_J = ['--run', RUN_ID, '--run-llm', '--allow-egress'];

  it('干跑:不构造后端(canary 不出现),退出 0', async () => {
    requireKitTmp();
    const w = await newWork();
    await writeProposal(w);
    const fake = await fakeCli(w.io, w.dir, 'codex', outputText());
    const c = await judgeCtx(
      w,
      ['--run', RUN_ID],
      overlayToml('egress = true') + BIND('codex', 'allow_unverified = true'),
      fake.env,
    );
    expect(await judgeCommand.run(c.ctx)).toBe(ExitCode.OK);
    expect(await exists(fake.canary)).toBe(false);
    // 干跑没有构造后端:计划里每一跳都是 error:not_configured,没有任何 planned:call
    const plan = JSON.parse(c.out.join('')) as {
      proposals: { hops: { result: string }[] }[];
    };
    const results = plan.proposals[0]?.hops.map((h) => h.result) ?? [];
    expect(results).toHaveLength(5);
    expect(results.every((r) => r === 'error:not_configured')).toBe(true);
  });

  it('正向对照:同样的覆盖层,真跑构造了后端(canary 出现、计划里有 ok 跳)', async () => {
    requireKitTmp();
    const w = await newWork();
    await writeProposal(w);
    const fake = await fakeCli(w.io, w.dir, 'codex', outputText());
    const c = await judgeCtx(
      w,
      LIVE_J,
      overlayToml('egress = true') + BIND('codex', 'allow_unverified = true'),
      fake.env,
    );
    expect(await judgeCommand.run(c.ctx)).toBe(ExitCode.OK);
    const out = JSON.parse(c.out.join('')) as { proposals: { hops: { result: string }[] }[] };
    expect(out.proposals[0]?.hops.map((h) => h.result)).toContain('ok');
  });

  it('真跑:覆盖层已同意但没绑任何槽位 → 4;未核实且没写 allow_unverified → 不 spawn;写了才评审成功并写 judge', async () => {
    requireKitTmp();
    const none = await newWork();
    await writeProposal(none);
    const c0 = await judgeCtx(none, LIVE_J, overlayToml('egress = true'));
    expect(await judgeCommand.run(c0.ctx)).toBe(ExitCode.NOT_RUN);
    expect(c0.err.join('')).toContain('没有可用的评审后端');

    const off = await newWork();
    await writeProposal(off);
    const fOff = await fakeCli(off.io, off.dir, 'codex', outputText());
    const c1 = await judgeCtx(off, LIVE_J, overlayToml('egress = true') + BIND('codex'), fOff.env);
    await judgeCommand.run(c1.ctx);
    expect(await exists(fOff.canary)).toBe(false);

    const on = await newWork();
    await writeProposal(on);
    const fOn = await fakeCli(on.io, on.dir, 'codex', outputText());
    const c2 = await judgeCtx(
      on,
      LIVE_J,
      overlayToml('egress = true') + BIND('codex', 'allow_unverified = true'),
      fOn.env,
    );
    expect(await judgeCommand.run(c2.ctx)).toBe(ExitCode.OK);
    expect(await exists(fOn.canary)).toBe(true);
    expect(await readText(path.join(on.runDir, 'proposals', '2026-10-12-001.yaml'))).toContain(
      'judge:',
    );
  });
});

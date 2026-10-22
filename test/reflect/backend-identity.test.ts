import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { runJudge } from '../../src/judge/run.js';
import type { LlmBackend } from '../../src/reflect/backend-iface.js';
import { provenVendorOf } from '../../src/reflect/backend-identity.js';
import { StubBackend as SrcStub, buildBackends } from '../../src/reflect/backends/index.js';
import { runReflect } from '../../src/reflect/run.js';
import { stageDir } from '../../src/reflect/stage.js';
import { setupEnv } from '../fixtures/reflect/world.js';
import {
  RUN_ID,
  StubBackend as JudgeStub,
  makeStubs,
  newWork,
  redactor,
  writeProposal,
} from '../judge/helpers.js';
import { fixture } from './backends/_fixture.js';

describe('后端自带 cli/provider:厂商由后端自己复算', () => {
  it('复算表:cli+provider+model 决定厂商;provider 被篡改厂商随之变', () => {
    const mk = (cli: string, provider: string | undefined, model: string) =>
      provenVendorOf(new SrcStub({ cli: cli as never, ...(provider ? { provider } : {}), model }));
    expect(mk('claude', undefined, 'claude-x')).toBe('anthropic');
    expect(mk('codex', undefined, 'gpt-5')).toBe('openai');
    expect(mk('pi', 'zai', 'glm-5.3-flash')).toBe('zhipu');
    // 同一个模型串,provider 换成另一家第一方 → 不可证明
    expect(mk('pi', 'deepseek', 'glm-5.3-flash')).toBe('unknown');
    expect(mk('pi', undefined, 'glm-5.3-flash')).toBe('zhipu');
  });

  it('缺 cli / 缺 provider 键 / stub / unconfigured / 非法值 → unknown(运行时校验,不信类型)', () => {
    const base = {
      slot: 'glm',
      vendor: 'zhipu',
      model: 'glm-5.3-flash',
      complete: async () => ({ ok: false }),
    };
    const cast = (o: object): LlmBackend => o as unknown as LlmBackend;
    expect(provenVendorOf(cast({ ...base, cli: 'pi', provider: undefined }))).toBe('zhipu'); // 正向对照
    expect(provenVendorOf(cast({ ...base, provider: undefined }))).toBe('unknown');
    expect(provenVendorOf(cast({ ...base, cli: 'pi' }))).toBe('unknown');
    expect(provenVendorOf(cast({ ...base, cli: 'stub', provider: undefined }))).toBe('unknown');
    expect(provenVendorOf(cast({ ...base, cli: 'unconfigured', provider: undefined }))).toBe(
      'unknown',
    );
    expect(provenVendorOf(cast({ ...base, cli: 'gemini', provider: undefined }))).toBe('unknown');
    expect(provenVendorOf(cast({ ...base, cli: 'pi', provider: 42 }))).toBe('unknown');
  });

  it('默认接线(buildBackends)与注入的后端得到相同厂商,且都暴露 cli/provider', async () => {
    const f = await fixture('identity-wire-');
    const list = buildBackends(
      { backends: [{ slot: 'glm', cli: 'pi', provider: 'zai', model: 'glm-5.3-flash' }] },
      f.deps(),
    );
    const built = list.find((b) => b.slot === 'glm')!;
    expect([built.cli, built.provider]).toEqual(['pi', 'zai']);
    const injected = new SrcStub({
      slot: 'glm',
      vendor: 'zhipu',
      model: 'glm-5.3-flash',
      cli: 'pi',
      provider: 'zai',
    });
    expect(provenVendorOf(built)).toBe('zhipu');
    expect(built.vendor).toBe(provenVendorOf(built));
    expect(provenVendorOf(injected)).toBe(provenVendorOf(built));
    // 未绑定的槽位占位:不是真实 CLI,厂商不可证明
    const idle = list.find((b) => b.slot === 'kimi')!;
    expect([idle.cli, provenVendorOf(idle)]).toEqual(['unconfigured', 'unknown']);
  });

  it('StubBackend 默认带 stub 标记', () => {
    const s = new SrcStub();
    expect([s.cli, s.provider]).toEqual(['stub', undefined]);
  });
});

describe('judge:注入后端缺身份 fail-closed', () => {
  const cast = (o: object): LlmBackend => o as unknown as LlmBackend;

  it('缺 cli / 缺 provider 键 / stub 标记 / provider 篡改 → vendor_unknown 且零调用;正向对照被调用', async () => {
    const w = await newWork();
    const file = await writeProposal(w);
    const s = makeStubs();
    const calls: string[] = [];
    const rec = (slot: string) => async () => {
      calls.push(slot);
      return { ok: false as const, reason: 'error' as const };
    };
    const noCli = cast({
      slot: 'codex',
      vendor: 'openai',
      model: 'gpt-example',
      provider: undefined,
      complete: rec('codex'),
    });
    const noProvider = cast({
      slot: 'maas-deepseek',
      vendor: 'deepseek',
      model: 'deepseek-example',
      cli: 'pi',
      complete: rec('maas-deepseek'),
    });
    const stubMarked = new JudgeStub('glm', 'zhipu', 'glm-example', undefined, 'stub');
    const tampered = new JudgeStub('kimi', 'moonshot', 'kimi-example', undefined, 'pi', 'deepseek');
    const good = new JudgeStub(
      'official-deepseek',
      'deepseek',
      'deepseek-example-2',
      undefined,
      'pi',
      'deepseek',
    );
    const rep = await runJudge(
      {
        io: w.io,
        redactor,
        backends: {
          codex: noCli,
          'maas-deepseek': noProvider,
          glm: stubMarked,
          kimi: tampered,
          'official-deepseek': good,
        },
      },
      { runId: RUN_ID, dry: false, maxCalls: 5 },
    );
    expect(calls).toEqual([]);
    expect([stubMarked, tampered].map((b) => b.calls.length)).toEqual([0, 0]);
    expect(good.calls).toHaveLength(1);
    expect(rep.outcomes[0]!.hops.map((h) => h.result)).toEqual([
      'error:vendor_unknown',
      'error:vendor_unknown',
      'error:vendor_unknown',
      'error:vendor_unknown',
      'ok',
    ]);
    expect(s.totalCalls()).toBe(0);
    expect(await exists(file)).toBe(true);
  });
});

describe('reflect:提案的 reflector.backend / stub 来自后端自己', () => {
  const stagedText = async (io: Parameters<typeof stageDir>[0], runId: string): Promise<string> => {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readDir(d)) {
        const p = path.join(d, e.name);
        if (e.isDirectory) await walk(p);
        else out.push(await readText(p));
      }
    };
    await walk(stageDir(io, runId));
    return out.join('\n');
  };
  it('缺 cli / 厂商与自身身份矛盾 → REFLECT_VENDOR_UNKNOWN,零调用', async () => {
    const env = await setupEnv();
    const calls: number[] = [];
    const noCli = {
      slot: 'codex',
      vendor: 'openai',
      model: 'gpt-5',
      provider: undefined,
      complete: async () => {
        calls.push(1);
        return { ok: false, reason: 'error' };
      },
    } as unknown as LlmBackend;
    await expect(runReflect({ ...env.deps, backend: noCli }, env.opts)).rejects.toMatchObject({
      code: 'REFLECT_VENDOR_UNKNOWN',
    });
    const liar = new SrcStub({ vendor: 'anthropic', model: 'gpt-5', cli: 'pi' });
    await expect(runReflect({ ...env.deps, backend: liar }, env.opts)).rejects.toMatchObject({
      code: 'REFLECT_VENDOR_UNKNOWN',
    });
    expect(calls.length + liar.calls).toBe(0);
  });

  it('stub 标记的后端:即使 llm 模式,提案也带 stub: true 且无 backend', async () => {
    const env = await setupEnv();
    const r = await runReflect(env.deps, {
      ...env.opts,
      mode: 'llm',
      allowEgress: true,
      runId: 'run-ident-1',
    });
    expect(r.report.outcome).toBe('staged');
    const text = await stagedText(env.w.io, 'run-ident-1');
    expect(text).toMatch(/stub: true/);
    expect(text).not.toMatch(/^\+\s+backend: /m);
  });

  it('真实 CLI 的注入后端:reflector.backend 取自后端本身,不带 stub', async () => {
    const env = await setupEnv();
    // 沿用 env 里的 stub 回复:把同一份脚本搬到带真实身份的后端上
    const delegate = env.backend;
    const injected: LlmBackend = {
      slot: 'codex',
      vendor: 'openai',
      model: 'gpt-5',
      cli: 'codex',
      provider: undefined,
      complete: (req) => delegate.complete(req),
    };
    const r = await runReflect(
      { ...env.deps, backend: injected },
      { ...env.opts, mode: 'llm', allowEgress: true, runId: 'run-ident-2' },
    );
    expect(r.report.outcome).toBe('staged');
    const text = await stagedText(env.w.io, 'run-ident-2');
    expect(text).toMatch(/backend: codex/);
    expect(text).not.toMatch(/stub: true/);
  });
});

describe('覆盖层反查路径已移除', () => {
  it('src 里没有 backendCli(命令层不再回头查覆盖层拿 CLI)', async () => {
    const hits: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readDir(d)) {
        const p = path.join(d, e.name);
        if (e.isDirectory) await walk(p);
        else if (p.endsWith('.ts') && (await readText(p)).includes('backendCli')) hits.push(p);
      }
    };
    await walk(path.join(REPO_ROOT, 'src'));
    expect(hits).toEqual([]);
  });
});

/**
 * `judge --ingest` / `--confirm-reflector`(N4)测试夹具:假终端(依赖倒置,不真开控制终端)、会话提案、payload、服务依赖。
 */
import * as path from 'node:path';
import { stringify } from 'yaml';
import type { TtyHandle, TtyPort, TtyReadResult } from '../../../src/io/tty.js';
import * as safe from '../../../src/io/safe-fs.js';
import { readText } from '../../../src/io/read-fs.js';
import { ruleSha256 } from '../../../src/lifecycle/checks.js';
import type { IngestDeps, LockedSession } from '../../../src/judge/ingest/types.js';
import {
  FROZEN_NOW,
  RUN_ID,
  VALID_OUTPUT,
  proposalObject,
  redactor,
  ruleMarkdown,
} from '../helpers.js';
import type { Work } from '../helpers.js';

export type KeyIn = string | { eof: true } | { timeout: true } | { tooLong: true };

/** 假终端:`input` 按顺序喂给每次 readLine;`writes` 记录写到控制终端句柄的全部文本 */
export class FakeTty implements TtyPort {
  readonly writes: string[] = [];
  readonly reads: number[] = [];
  opened = 0;
  closed = 0;
  clock = Date.parse('2026-10-14T05:41:00Z');
  constructor(public input: KeyIn[] = []) {}
  readonly handle = {} as unknown as TtyHandle;
  open(): TtyHandle | undefined {
    this.opened++;
    return this.handle;
  }
  async readLine(_h: TtyHandle, maxBytes: number, deadline: number): Promise<TtyReadResult> {
    this.reads.push(deadline - this.clock);
    const next = this.input.shift();
    if (next === undefined) return { kind: 'eof' };
    if (typeof next === 'string') {
      return Buffer.byteLength(next) > maxBytes
        ? { kind: 'too_long' }
        : { kind: 'line', text: next };
    }
    if ('eof' in next) return { kind: 'eof' };
    if ('timeout' in next) return { kind: 'timeout' };
    return { kind: 'too_long' };
  }
  write(_h: TtyHandle, text: string): void {
    this.writes.push(text);
  }
  close(): void {
    this.closed++;
  }
  now(): number {
    return this.clock;
  }
  get screen(): string {
    return this.writes.join('');
  }
}

export interface SessionSpec {
  id?: string;
  target?: string;
  layer?: 'team' | 'personal';
  provenance?: 'session_declared' | 'spawned';
  backend?: 'claude' | 'codex' | 'pi';
  inputDigest?: string;
  op?: string;
  guidance?: Record<string, unknown>;
  signature?: 'phrase' | 'tool' | 'path' | 'always' | 'none';
  judge?: unknown;
}

/** 写一个会话提案(A4 ingest 写出的形状)+ 规则文件;返回提案文件路径与规则文件原文 */
export async function writeSessionProposal(
  w: Work,
  spec: SessionSpec = {},
): Promise<{ file: string; rulePath: string; ruleText: string; ruleSha: string; id: string }> {
  const layer = spec.layer ?? 'team';
  const target = spec.target ?? 'new-rule-a';
  const base = proposalObject({
    ...(spec.id !== undefined ? { id: spec.id } : {}),
    target,
    layer,
    ...(spec.guidance !== undefined ? { guidance: spec.guidance } : {}),
  });
  const reflector = base['reflector'] as Record<string, unknown>;
  const {
    stub: _s,
    prompt_id: _p,
    guidance,
    ...keep
  } = reflector as { stub?: unknown; prompt_id?: unknown; guidance?: unknown };
  void _s;
  void _p;
  const sessionReflector =
    (spec.provenance ?? 'session_declared') === 'session_declared'
      ? {
          ...keep,
          provider: 'session',
          vendor: 'unknown',
          model: 'undeclared',
          backend: spec.backend ?? 'claude',
          provenance: 'session_declared',
          input_digest: spec.inputDigest ?? `sha256:${'a'.repeat(64)}`,
          kit_version: '0.2.0',
        }
      : { ...keep, provenance: 'spawned', backend: spec.backend ?? 'claude' };
  const obj: Record<string, unknown> = {
    ...base,
    op: spec.op ?? 'add',
    reflector: { ...sessionReflector, ...(guidance !== undefined ? { guidance } : {}) },
    ...(spec.judge !== undefined ? { judge: spec.judge } : {}),
  };
  const id = obj['id'] as string;
  const file = path.join(w.runDir, 'proposals', `${id}.yaml`);
  await safe.mkdirp(w.io, path.dirname(file));
  await safe.writeFile(w.io, file, stringify(obj, { lineWidth: 0 }), { mode: 0o600 });
  const rulePath = path.join(w.runDir, 'rules', layer, `${target}.md`);
  await safe.mkdirp(w.io, path.dirname(rulePath));
  const ruleText = ruleMarkdown({
    target,
    layer,
    ...(spec.signature !== undefined ? { signature: spec.signature } : {}),
  });
  await safe.writeFile(w.io, rulePath, ruleText, { mode: 0o600 });
  return { file, rulePath, ruleText, ruleSha: ruleSha256(ruleText), id };
}

export const DECLARED = { agent: 'codex', vendor: 'openai', model: 'gpt-example' } as const;

export interface VerdictSpec {
  id: string;
  rule_sha256: string;
  output?: Record<string, unknown>;
}

export function payloadText(
  verdicts: VerdictSpec[],
  over: {
    declared?: Record<string, unknown>;
    run_id?: string;
    schema?: string;
    extra?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    schema: over.schema ?? 'judge-ingest-v1',
    run_id: over.run_id ?? RUN_ID,
    declared: over.declared ?? DECLARED,
    verdicts: verdicts.map((v) => ({
      id: v.id,
      rule_sha256: v.rule_sha256,
      output: v.output ?? { ...VALID_OUTPUT },
    })),
    ...over.extra,
  });
}

export const noopSession: LockedSession = {
  enter: async () => undefined,
  assertHeld: async () => undefined,
  gate: async () => null,
  settle: async () => undefined,
};

export interface DepsOpts {
  tty?: FakeTty;
  session?: Partial<LockedSession>;
  order?: string[];
  forbidden?: string[];
  storeFs?: IngestDeps['storeFs'];
  afterConfirm?: () => Promise<void> | void;
  resolveHead?: () => string | undefined;
  gate?: IngestDeps['gate'];
  noHandle?: boolean;
}

export function makeDeps(w: Work, o: DepsOpts = {}): IngestDeps & { tty: FakeTty } {
  const tty = o.tty ?? new FakeTty();
  const order = o.order;
  return {
    io: w.io,
    redactor,
    tty,
    ...(o.noHandle === true ? {} : { ttyHandle: tty.handle }),
    now: () => FROZEN_NOW,
    kitVersion: '0.2.0',
    forbidden: o.forbidden ?? [w.dir],
    gate: o.gate ?? (async () => null),
    underLock: async (fn) => {
      order?.push('lock');
      return fn({ ...noopSession, ...o.session });
    },
    resolveHead: o.resolveHead ?? ((): string => w.head),
    ...(o.storeFs !== undefined ? { storeFs: o.storeFs } : {}),
    hooks: { ...(o.afterConfirm !== undefined ? { afterConfirm: o.afterConfirm } : {}) },
  };
}

export const readRaw = (file: string): Promise<string> => readText(file);

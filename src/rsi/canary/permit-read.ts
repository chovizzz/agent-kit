/**
 * hint `--canary` 的**只读**许可读取(docs/contracts.md R21-6.10 的读集合):`.state/rsi/{canary.json, canary-admission.json, AUTO_PAUSE}` 与
 * HOME 侧 `rsi-personal/revocations.jsonl`(≤ 1MiB,超出按读取失败处理)的存在性与内容。**不读私有仓库、不读信号库、不拿锁、不写。**
 *
 * 每个输入三态:`absent`(确认不存在)/ `ok` / `unreadable`(读不到、不安全、超限、解析或 schema 失败)——**不可读不等于不存在**(R21-6.11 第 4a 行):
 * 调用方对 `unreadable` 一律按「不授予」处理,不得当作「没有凭据 / 没有暂停」。读取全部经句柄级 `readFileSafe`(O_NOFOLLOW、普通文件、nlink == 1、属主与权限),
 * 校验后不重读同一个对象(跨信任边界一律运行时校验)。
 *
 * 本文件**不 import** `src/rsi/personal/home-state.ts`(它带 home-fs 写出口):撤销凭据的固定位置在这里自带一份常量,由测试钉住与 home-state 一致。
 */
import * as path from 'node:path';
import {
  CanaryAdmissionSchema,
  CanaryDocSchema,
  RsiRevocationLineSchema,
  type CanaryAdmission,
  type CanaryDoc,
  type RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import { RSI_REVOCATIONS_MAX_BYTES } from '../../contracts/rsi.js';
import { lstat, readFileSafe } from '../../io/read-fs.js';
import { RSI_FILE_OWNER } from '../lock-read.js';
import { CANARY_FILES } from './files.js';

export type Read3<T> = { kind: 'absent' } | { kind: 'ok'; value: T } | { kind: 'unreadable' };
export type PauseRead = 'absent' | 'present' | 'unreadable';

/** 与 `src/rsi/personal/home-state.ts` 的 `PERSONAL_STATE_REL` / `PERSONAL_STATE_FILES.revocations` 同值(测试钉住) */
export const REVOCATIONS_REL = '.local/state/agent-kit/rsi-personal/revocations.jsonl';

/** `canary.json` / `canary-admission.json` 的读取上限(远大于合法内容:正文 ≤ 1536 字节) */
const DOC_MAX_BYTES = 64 * 1024;

/** hint 看到的四个输入,惰性读取(判定顺序决定哪些会被读到) */
export interface PermitPort {
  pause(): Promise<PauseRead>;
  admission(): Promise<Read3<CanaryAdmission>>;
  canary(): Promise<Read3<CanaryDoc>>;
  revocations(): Promise<Read3<readonly RsiRevocationLine[]>>;
}

async function readJsonDoc<T>(
  file: string,
  parse: (v: unknown) => T | undefined,
): Promise<Read3<T>> {
  const r = await readFileSafe(file, { maxBytes: DOC_MAX_BYTES, owner: RSI_FILE_OWNER });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') return { kind: 'unreadable' };
  let raw: unknown;
  try {
    raw = JSON.parse(r.bytes.toString('utf8'));
  } catch {
    return { kind: 'unreadable' };
  }
  const v = parse(raw);
  return v === undefined ? { kind: 'unreadable' } : { kind: 'ok', value: v };
}

/** `AUTO_PAUSE`:只判存在(与 STOP 同口径:任何已存在的条目都算在场,确认不了 = `unreadable`) */
async function readPause(file: string): Promise<PauseRead> {
  try {
    await lstat(file);
    return 'present';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/** 撤销凭据全文解析:逐行 JSON + schema;缺尾换行、空行、任一行不合规 → `unreadable` */
export function parseRevocations(text: string): Read3<readonly RsiRevocationLine[]> {
  if (text === '') return { kind: 'ok', value: [] };
  if (!text.endsWith('\n')) return { kind: 'unreadable' };
  const lines: RsiRevocationLine[] = [];
  for (const l of text.slice(0, -1).split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      return { kind: 'unreadable' };
    }
    const p = RsiRevocationLineSchema.safeParse(raw);
    if (!p.success) return { kind: 'unreadable' };
    lines.push(p.data);
  }
  return { kind: 'ok', value: lines };
}

async function readRevocations(file: string): Promise<Read3<readonly RsiRevocationLine[]>> {
  const r = await readFileSafe(file, {
    maxBytes: RSI_REVOCATIONS_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') return { kind: 'unreadable' };
  return parseRevocations(r.bytes.toString('utf8'));
}

export const readCanaryDoc = (rsiDir: string): Promise<Read3<CanaryDoc>> =>
  readJsonDoc(path.join(rsiDir, CANARY_FILES.canary), (v) => {
    const p = CanaryDocSchema.safeParse(v);
    return p.success ? p.data : undefined;
  });

export const readAdmissionDoc = (rsiDir: string): Promise<Read3<CanaryAdmission>> =>
  readJsonDoc(path.join(rsiDir, CANARY_FILES.admission), (v) => {
    const p = CanaryAdmissionSchema.safeParse(v);
    return p.success ? p.data : undefined;
  });

/** 生产端口:`rsiDir` 是 `rsiDirReadonly` 已确认安全的 `.state/rsi` 目录,`home` 是 HOME(撤销凭据的位置) */
export function makePermitPort(rsiDir: string, home: string): PermitPort {
  return {
    pause: () => readPause(path.join(rsiDir, CANARY_FILES.pause)),
    admission: () => readAdmissionDoc(rsiDir),
    canary: () => readCanaryDoc(rsiDir),
    revocations: () => readRevocations(path.join(home, ...REVOCATIONS_REL.split('/'))),
  };
}

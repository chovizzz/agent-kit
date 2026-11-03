/**
 * 唯一的控制终端出口(N4,docs/contracts.md §20.18,R20-18.5 / R20-18.25 / R20-18.6)。
 *
 * - 控制终端 `/dev/tty` 的打开与行读取只允许经本文件:`/dev/tty` 字面量与 `node:tty` 的引用 eslint 限定它(§5 出口表「唯一控制终端出口」);
 *   本文件只许 `src/commands/judge-ingest.ts` 与 `src/judge/ingest/**`(及其测试)引用——自动入口(poke / hint / worker / 顺带调度 / sync / update)的 import 闭包不得含它。
 * - 确认屏与全部提示写到这个句柄,确认输入也只从它读(不用 stdout / stderr / stdin):stdout 保持干净,`--json` 捕获不被污染。
 * - **`TtyConfirmedProof`(不可伪造令牌)**:「用户在本机 TTY 亲手键入了厂商名」这件事只能由本文件的 {@link runTypedConfirmation} 产生。
 *   令牌是一个不透明的冻结对象,内容存在本模块私有的 WeakMap 里;类型上带一个未导出的 `unique symbol` 品牌,模块外无法构造该类型的字面量(`tsc` 强制),
 *   运行期 {@link readProof} 只认本模块登记过的对象——复制、展开、JSON 往返得到的东西都读不出内容。写入服务只收令牌,不收布尔(依赖倒置)。
 *   **前提:令牌始终在同一进程内传递**(命令入口 → 服务);它不可序列化,也不应该被序列化。
 * - 威胁模型:TTY 判据只是尽力区分人与脚本(同 R20-3.6.4,有 shell 的 agent 可以开伪终端),**不是安全边界**。
 * - 依赖倒置:{@link TtyPort} 是端口,命令层注入;测试注入假终端(假句柄 + 假时钟),不真开 `/dev/tty`。
 */
import * as fs from 'node:fs';
import * as tty from 'node:tty';
import { BUILTIN_VENDORS, CONFIRMED_MODEL_RE, UNKNOWN_VENDOR } from '../contracts/vendor.js';

// ---------------------------------------------------------------- 端口

declare const ttyHandleBrand: unique symbol;
/** 不透明的控制终端句柄 */
export interface TtyHandle {
  readonly [ttyHandleBrand]: true;
}

export type TtyReadResult =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'eof' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too_long' };

export interface TtyPort {
  /** 以读写方式打开控制终端且该句柄 `isatty`;无控制终端(典型:会话 agent 的无 TTY 工具进程)→ undefined */
  open(): TtyHandle | undefined;
  /** 读一行(不含行尾):最多 `maxBytes` 字节,`deadline`(绝对毫秒时刻)前没有一整行 → timeout */
  readLine(handle: TtyHandle, maxBytes: number, deadline: number): Promise<TtyReadResult>;
  write(handle: TtyHandle, text: string): void;
  close(handle: TtyHandle): void;
  /** 时钟(毫秒);假终端注入假时钟 */
  now(): number;
}

interface RealHandle {
  readonly fd: number;
  readonly input: tty.ReadStream;
}
const realHandles = new WeakSet<object>();

/** 打开控制终端。打不开(无控制终端 / 无 `/dev/tty` 的平台)→ undefined,不抛 */
export function openControlTty(): TtyHandle | undefined {
  let fd: number;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDWR);
  } catch {
    return undefined;
  }
  try {
    if (!tty.isatty(fd)) {
      fs.closeSync(fd);
      return undefined;
    }
    const h: RealHandle = { fd, input: new tty.ReadStream(fd) };
    h.input.pause();
    realHandles.add(h);
    return h as unknown as TtyHandle;
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* 已尽力 */
    }
    return undefined;
  }
}

function real(handle: TtyHandle): RealHandle {
  if (!realHandles.has(handle as unknown as object)) throw new Error('TTY_HANDLE_UNKNOWN');
  return handle as unknown as RealHandle;
}

export function writeControlTty(handle: TtyHandle, text: string): void {
  fs.writeSync(real(handle).fd, text);
}

/** 读一行;含 `\n` 的数据到达即返回(其后数据丢弃——一次提示只收一行) */
export function readLine(
  handle: TtyHandle,
  maxBytes: number,
  deadline: number,
  now: () => number = Date.now,
): Promise<TtyReadResult> {
  const h = real(handle);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const st: { timer: NodeJS.Timeout | undefined } = { timer: undefined };
    const finish = (r: TtyReadResult): void => {
      if (st.timer !== undefined) clearTimeout(st.timer);
      h.input.off('data', onData);
      h.input.off('end', onEnd);
      h.input.off('error', onEnd);
      h.input.pause();
      resolve(r);
    };
    const onData = (c: Buffer | string): void => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      const nl = b.indexOf(0x0a);
      const piece = nl >= 0 ? b.subarray(0, nl) : b;
      total += piece.length;
      if (total > maxBytes) return finish({ kind: 'too_long' });
      chunks.push(piece);
      if (nl >= 0) {
        return finish({ kind: 'line', text: Buffer.concat(chunks, total).toString('utf8') });
      }
    };
    const onEnd = (): void => finish({ kind: 'eof' });
    h.input.on('data', onData);
    h.input.on('end', onEnd);
    h.input.on('error', onEnd);
    st.timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, deadline - now()));
    h.input.resume();
  });
}

export function closeControlTty(handle: TtyHandle): void {
  const h = real(handle);
  try {
    h.input.destroy();
  } catch {
    /* 已尽力 */
  }
  realHandles.delete(handle as unknown as object);
}

/** 真实终端端口(命令入口的缺省接线) */
export const REAL_TTY_PORT: TtyPort = Object.freeze({
  open: openControlTty,
  readLine: (handle: TtyHandle, maxBytes: number, deadline: number) =>
    readLine(handle, maxBytes, deadline),
  write: writeControlTty,
  close: closeControlTty,
  now: () => Date.now(),
});

// ---------------------------------------------------------------- 令牌

declare const proofBrand: unique symbol;
/** 「用户在本机 TTY 亲手键入了厂商名」的不可伪造令牌(模块外无法构造;见文件头) */
export interface TtyConfirmedProof {
  readonly [proofBrand]: true;
}

/** 令牌携带的、由用户键入(而非 agent 声明)的值 */
export interface TtyProofData {
  /** 裁判侧:用户键入的厂商名(规范化后;与 `declared.vendor` 逐字节全等才会走到这里);`--confirm-reflector` 无此步 → undefined */
  readonly judgeVendor: string | undefined;
  /** 反思器侧:用户键入的厂商 / 模型;空行跳过 → `skipped`;本次没问 → `not_asked` */
  readonly reflector:
    | { readonly kind: 'typed'; readonly vendor: string; readonly model: string }
    | { readonly kind: 'skipped' }
    | { readonly kind: 'not_asked' };
  /** 令牌铸造时刻(ISO 秒精度,假时钟下可控) */
  readonly confirmedAt: string;
  /** 铸造时绑定的展示指纹(服务在锁内重算,不符 → STALE) */
  readonly fingerprint: string;
}

const proofs = new WeakMap<object, TtyProofData>();

function mint(data: TtyProofData): TtyConfirmedProof {
  const minted = Object.freeze({});
  proofs.set(minted, Object.freeze({ ...data }));
  return minted as unknown as TtyConfirmedProof;
}

/** 读令牌内容;不是本模块铸造的对象(复制 / 展开 / 反序列化 / 手写)→ undefined */
export function readProof(proof: unknown): TtyProofData | undefined {
  return typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
}

// ---------------------------------------------------------------- 键入确认

/** 单次提示:行上限 128 字节、120 秒无输入视为放弃(R20-18.6 第 2 步) */
export const TYPED_LINE_MAX_BYTES = 128;
export const TYPED_LINE_TIMEOUT_MS = 120_000;

export type ConfirmDeclineReason =
  | 'no_input' // EOF
  | 'timeout'
  | 'too_long'
  | 'invalid' // 含非 ASCII / 控制字符 / 空 / 不等 / 非规范厂商 / 模型串非法
  | 'tty_write_failed';

export type TypedConfirmation =
  | { readonly ok: true; readonly proof: TtyConfirmedProof }
  | { readonly ok: false; readonly reason: ConfirmDeclineReason };

export interface TypedConfirmationSpec {
  /** 展示屏(调用方从校验后的枚举值构造并清洗过;本函数原样写到句柄) */
  readonly screen: string;
  /** 裁判侧:要求键入的厂商名(= `declared.vendor`,规范小写);undefined = 不问裁判侧(`--confirm-reflector`) */
  readonly expectJudgeVendor: string | undefined;
  /** 反思器侧:undefined = 不问;否则展示可选厂商清单并要求键入厂商与模型 */
  readonly reflector:
    | { readonly prompt: string; readonly allowSkip: boolean; readonly choices: readonly string[] }
    | undefined;
  readonly fingerprint: string;
}

/** 去行尾 `\n` / `\r\n` / `\r`(行读取在 `\n` 处断开,CRLF 输入会留下行尾 `\r`) */
function stripEol(raw: string): string {
  return raw.replace(/[\r\n]+$/, '');
}

/** ASCII 小写折叠 + 去首尾 ASCII 空白;含非 ASCII 字节 / 控制字符 / 空 → undefined */
export function foldTyped(raw: string): string | undefined {
  const noEol = stripEol(raw);
  const trimmed = noEol.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') return undefined;
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return undefined;
  return trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

async function askLine(port: TtyPort, h: TtyHandle): Promise<TtyReadResult> {
  return port.readLine(h, TYPED_LINE_MAX_BYTES, port.now() + TYPED_LINE_TIMEOUT_MS);
}

/**
 * 键入确认(唯一铸造令牌的地方)。流程(R20-18.6 第 2–3 步):写展示屏;裁判侧单次机会键入厂商名,与 `expectJudgeVendor` **逐字节全等**
 * (去行尾、去首尾 ASCII 空白、ASCII 大写折小写后);含非 ASCII 字节、控制字符、超长、空、EOF、不等 → 放弃。不重试、不提供默认值、不接受 y / yes / 回车。
 * 反思器侧(如要求):键入厂商(空行 = 跳过,仅当 `allowSkip`)与模型串;厂商非空但不是内置规范厂商、模型串空 / 非法 → 放弃。
 * **kit 不把用户的键入内容写进** 任何输出;返回的放弃原因只有枚举。
 */
export async function runTypedConfirmation(
  port: TtyPort,
  handle: TtyHandle,
  spec: TypedConfirmationSpec,
): Promise<TypedConfirmation> {
  const decline = (reason: ConfirmDeclineReason): TypedConfirmation => ({ ok: false, reason });
  const fromRead = (r: TtyReadResult): ConfirmDeclineReason | undefined =>
    r.kind === 'eof'
      ? 'no_input'
      : r.kind === 'timeout'
        ? 'timeout'
        : r.kind === 'too_long'
          ? 'too_long'
          : undefined;
  try {
    port.write(handle, spec.screen);
  } catch {
    return decline('tty_write_failed');
  }
  let judgeVendor: string | undefined;
  if (spec.expectJudgeVendor !== undefined) {
    try {
      port.write(handle, '\n请键入自报的厂商名(单次机会,120 秒内): ');
    } catch {
      return decline('tty_write_failed');
    }
    const r = await askLine(port, handle);
    const bad = fromRead(r);
    if (bad !== undefined) return decline(bad);
    const folded = r.kind === 'line' ? foldTyped(r.text) : undefined;
    if (folded === undefined || folded !== spec.expectJudgeVendor) return decline('invalid');
    judgeVendor = folded;
  }
  let reflector: TtyProofData['reflector'] = { kind: 'not_asked' };
  if (spec.reflector !== undefined) {
    try {
      port.write(
        handle,
        `\n${spec.reflector.prompt}\n可选厂商:${spec.reflector.choices.join('、')}\n反思器厂商${spec.reflector.allowSkip ? '(空行 = 跳过)' : ''}: `,
      );
    } catch {
      return decline('tty_write_failed');
    }
    const rv = await askLine(port, handle);
    const badV = fromRead(rv);
    if (badV !== undefined) return decline(badV);
    const rawV = rv.kind === 'line' ? stripEol(rv.text).replace(/^[ \t]+|[ \t]+$/g, '') : '';
    if (rawV === '' && spec.reflector.allowSkip) {
      reflector = { kind: 'skipped' };
    } else {
      const vendor = foldTyped(rawV);
      if (vendor === undefined || vendor === UNKNOWN_VENDOR || !BUILTIN_VENDORS.includes(vendor)) {
        return decline('invalid');
      }
      try {
        port.write(handle, '反思器模型串: ');
      } catch {
        return decline('tty_write_failed');
      }
      const rm = await askLine(port, handle);
      const badM = fromRead(rm);
      if (badM !== undefined) return decline(badM);
      const model = rm.kind === 'line' ? foldTyped(rm.text) : undefined;
      if (model === undefined || !CONFIRMED_MODEL_RE.test(model)) return decline('invalid');
      reflector = { kind: 'typed', vendor, model };
    }
  }
  const confirmedAt = new Date(port.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    ok: true,
    proof: mint({ judgeVendor, reflector, confirmedAt, fingerprint: spec.fingerprint }),
  };
}

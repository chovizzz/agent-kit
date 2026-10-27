/**
 * 流式 JSONL 校验引擎(R20-A2 B2,docs/contracts.md §20.5 R20-5.6 订正):快照提交 / 恢复读月文件(信号库、会话计数)用,
 * 不把整个文件载入内存,也**不复用** `readLines`(后者会去掉行尾 `\r`、接受没有末尾换行的尾行、把超长行换成占位串)。
 *
 * 入参是**原始字节块**(与计算 sha256 / 字节数的是同一批块):
 *  - 只按字节 `0x0a` 切行,所以多字节 UTF-8 字符跨块、`\r\n` 的 `\r` 与 `\n` 落在两个块里都不影响切分;
 *  - 一行的字节凑齐后才整体按 UTF-8(`fatal`、保留 BOM)解码,再 `JSON.parse`,再交给调用方的记录校验;
 *    行尾的 `\r` 留给 `JSON.parse`(它当空白处理):CRLF 文件与 LF 文件判定一致,不在这里归一化;
 *  - 空行、非法 UTF-8、非 JSON、记录校验为否、单行超过 `maxLineBytes`(超过即停,不再累积)、文件末尾缺 `\n` 的尾行,一律失败;
 *  - 空文件合法。
 * 失败抛 {@link JsonlStreamError};调用方负责关句柄(`openStreamSafe` 的生成器在 `for await` 提前退出时会关)。
 */
export type JsonlFailure =
  'too_long' | 'bad_utf8' | 'bad_json' | 'bad_record' | 'no_trailing_newline';

export class JsonlStreamError extends Error {
  readonly code = 'RSI_JSONL_INVALID';
  constructor(readonly why: JsonlFailure) {
    super(`jsonl: ${why}`);
  }
}

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class JsonlStream {
  private parts: Buffer[] = [];
  private len = 0;
  /** 自上一个 `\n` 之后是否已有字节(= 尾行是否缺换行) */
  private pending = false;
  /** 已完整校验的记录行数 */
  lines = 0;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onRecord: (value: unknown) => boolean,
  ) {}

  /** 文件是否以 `\n` 结尾(空文件为 true) */
  get endsWithNewline(): boolean {
    return !this.pending;
  }

  push(chunk: Buffer): void {
    let pos = 0;
    for (;;) {
      const idx = chunk.indexOf(0x0a, pos);
      if (idx < 0) {
        this.append(chunk.subarray(pos));
        return;
      }
      this.append(chunk.subarray(pos, idx));
      this.finishLine();
      pos = idx + 1;
    }
  }

  /** 读完后调用:尾行缺换行 → 失败 */
  end(): void {
    if (this.pending) throw new JsonlStreamError('no_trailing_newline');
  }

  private append(seg: Buffer): void {
    if (seg.length === 0) return;
    this.pending = true;
    if (this.len + seg.length > this.maxLineBytes) throw new JsonlStreamError('too_long');
    this.parts.push(seg);
    this.len += seg.length;
  }

  private finishLine(): void {
    const bytes = Buffer.concat(this.parts, this.len);
    this.parts = [];
    this.len = 0;
    this.pending = false;
    let text: string;
    try {
      text = DECODER.decode(bytes);
    } catch {
      throw new JsonlStreamError('bad_utf8');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new JsonlStreamError('bad_json');
    }
    if (!this.onRecord(value)) throw new JsonlStreamError('bad_record');
    this.lines++;
  }
}

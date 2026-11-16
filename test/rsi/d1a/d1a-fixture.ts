/**
 * D1a 测试夹具:固定测试密钥(字节 1..32)与「输出不含密钥」的检查。**密钥只用于测试,不是任何真实密钥**。
 * `leaks` 同时查三种常见编码(十六进制、base64、逗号分隔字节),`leaksValue` 把 Uint8Array 按字节展开后再查。
 */
export const TEST_KEY: Uint8Array = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const TEST_KEY_HEX = Buffer.from(TEST_KEY).toString('hex');
export const TEST_KEY_B64 = Buffer.from(TEST_KEY).toString('base64');
export const TEST_KEY_CSV = Array.from(TEST_KEY).join(',');

export function leaks(text: string): boolean {
  return text.includes(TEST_KEY_HEX) || text.includes(TEST_KEY_B64) || text.includes(TEST_KEY_CSV);
}

export function leaksValue(v: unknown): boolean {
  const text = JSON.stringify(v, (_k, x: unknown) =>
    x instanceof Uint8Array ? Array.from(x).join(',') : x,
  );
  return leaks(text ?? '');
}

/** 异常 / 值 → 文本(`name` + `message` + `code`),用于「错误信息不含密钥」 */
export function errText(e: unknown): string {
  const x = e as { name?: string; message?: string; code?: string };
  return `${x.name ?? ''}|${x.code ?? ''}|${x.message ?? ''}`;
}

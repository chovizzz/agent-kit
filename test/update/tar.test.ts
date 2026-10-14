import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBytes } from '../../src/io/read-fs.js';
import { DEFAULT_TAR_LIMITS, TarError, readTgz } from '../../src/update/tar.js';
import type { TarErrorCode, TarLimits } from '../../src/update/tar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC0_TGZ = path.join(HERE, 'fixtures', 'agent-kit-0.1.0-rc.0.tgz');

// ---------------------------------------------------------------------------
// 构造 tar 的最小工具(仅测试用)
// ---------------------------------------------------------------------------

interface Ent {
  name: string;
  type?: string;
  data?: Buffer | string;
  mode?: number;
  linkname?: string;
  prefix?: string;
  /** 直接写进 name 字段的原始字节(用来造 NUL 后藏数据) */
  rawName?: Buffer;
}

function oct(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(e: Ent, size: number): Buffer {
  const h = Buffer.alloc(512);
  (e.rawName ?? Buffer.from(e.name)).copy(h, 0);
  h.write(oct(e.mode ?? 0o644, 8), 100, 'latin1');
  h.write(oct(0, 8), 108, 'latin1');
  h.write(oct(0, 8), 116, 'latin1');
  h.write(oct(size, 12), 124, 'latin1');
  h.write(oct(0, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname) h.write(e.linkname, 157, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  if (e.prefix) h.write(e.prefix, 345, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function entry(e: Ent): Buffer {
  const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(e, data.length), data, pad]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len)
    len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

const END = Buffer.alloc(1024);

function tar(entries: Ent[], opts: { end?: Buffer } = {}): Buffer {
  return Buffer.concat([...entries.map(entry), opts.end ?? END]);
}

function tgz(entries: Ent[], opts: { end?: Buffer } = {}): Buffer {
  return gzipSync(tar(entries, opts));
}

function code(fn: () => unknown): TarErrorCode | 'NO_ERROR' {
  try {
    fn();
  } catch (e) {
    if (e instanceof TarError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

const OK: Ent[] = [
  { name: 'package/', type: '5', mode: 0o755 },
  { name: 'package/package.json', data: '{"name":"x"}' },
  { name: 'package/dist/', type: '5' },
  { name: 'package/dist/cli.js', data: 'console.log(1)', mode: 0o755 },
];

// ---------------------------------------------------------------------------

describe('tar 读取器:合法输入', () => {
  it('真实 rc.0 tarball(npm pack 产物)可解析,所有路径都在包根内,文件非空', async () => {
    const r = readTgz(await readBytes(RC0_TGZ));
    expect(r.files.length).toBeGreaterThan(10);
    expect(r.files.some((f) => f.path === 'package.json')).toBe(true);
    for (const f of r.files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path.split('/')).not.toContain('..');
      expect([0o644, 0o755]).toContain(f.mode);
    }
    const pkg = JSON.parse(r.files.find((f) => f.path === 'package.json')!.bytes.toString('utf8'));
    expect(pkg.name).toBe('@chovizzz/agent-kit');
    expect(pkg.version).toBe('0.1.0-rc.0');
  });

  it('文件清单:路径去掉 package/ 前缀,显式目录单列,包根自身不出现', () => {
    const r = readTgz(tgz(OK));
    expect(r.files.map((f) => [f.path, f.mode])).toEqual([
      ['package.json', 0o644],
      ['dist/cli.js', 0o755],
    ]);
    expect(r.dirs).toEqual(['dist']);
    expect(r.files[0]!.bytes.toString()).toBe('{"name":"x"}');
  });

  it('权限归一:setuid / setgid / sticky / 写位全部丢弃,只留 0644 / 0755', () => {
    const r = readTgz(
      tgz([
        { name: 'package/a', data: 'a', mode: 0o4777 },
        { name: 'package/b', data: 'b', mode: 0o2666 },
        { name: 'package/c', data: 'c', mode: 0o1600 },
        { name: 'package/d', data: 'd', mode: 0o100 },
        { name: 'package/e', data: 'e', mode: 0 },
      ]),
    );
    expect(r.files.map((f) => f.mode)).toEqual([0o755, 0o644, 0o644, 0o755, 0o644]);
  });

  it('pax 长路径(path 记录,超过 100 字节)被采用', () => {
    const long = `package/${'d'.repeat(60)}/${'f'.repeat(60)}/file.txt`;
    const r = readTgz(
      tgz([
        { name: 'PaxHeader', type: 'x', data: paxRecord('path', long) },
        { name: 'package/short', data: 'hello' },
      ]),
    );
    expect(r.files.map((f) => f.path)).toEqual([long.slice('package/'.length)]);
    expect(r.files[0]!.bytes.toString()).toBe('hello');
  });

  it('ustar prefix + name 拼接', () => {
    const r = readTgz(tgz([{ name: 'file.txt', prefix: 'package/sub', data: 'x' }]));
    expect(r.files.map((f) => f.path)).toEqual(['sub/file.txt']);
  });

  it('空包(只有结束块)得到空清单', () => {
    expect(readTgz(tgz([]))).toEqual({ files: [], dirs: [] });
  });
});

describe('tar 读取器:路径拒绝码(正反例)', () => {
  const cases: Array<[TarErrorCode, string, Ent[]]> = [
    ['TAR_SYMLINK', '符号链接', [{ name: 'package/ln', type: '2', linkname: '/etc/passwd' }]],
    ['TAR_HARDLINK', '硬链接', [{ name: 'package/hl', type: '1', linkname: 'package/x' }]],
    ['TAR_DEVICE', '字符设备', [{ name: 'package/dev', type: '3' }]],
    ['TAR_DEVICE', '块设备', [{ name: 'package/dev', type: '4' }]],
    ['TAR_DEVICE', 'FIFO', [{ name: 'package/fifo', type: '6' }]],
    [
      'TAR_UNSUPPORTED_TYPE',
      'GNU 长名',
      [{ name: '././@LongLink', type: 'L', data: 'package/x\0' }],
    ],
    [
      'TAR_UNSUPPORTED_TYPE',
      '全局 pax 头',
      [{ name: 'g', type: 'g', data: paxRecord('comment', 'x') }],
    ],
    ['TAR_ABSOLUTE_PATH', '绝对路径', [{ name: '/etc/passwd', data: 'x' }]],
    ['TAR_PATH_TRAVERSAL', '.. 开头', [{ name: '../evil', data: 'x' }]],
    ['TAR_PATH_TRAVERSAL', 'package/ 内的 ..', [{ name: 'package/../../evil', data: 'x' }]],
    ['TAR_PATH_TRAVERSAL', '中间 ..', [{ name: 'package/a/../b', data: 'x' }]],
    ['TAR_EMPTY_SEGMENT', '空段 //', [{ name: 'package//x', data: 'x' }]],
    ['TAR_BAD_PATH', '. 段', [{ name: 'package/./x', data: 'x' }]],
    ['TAR_BAD_PATH', '反斜杠', [{ name: 'package/a\\b', data: 'x' }]],
    ['TAR_BAD_PATH', '盘符', [{ name: 'C:/x', data: 'x' }]],
    ['TAR_BAD_PATH', '控制字符', [{ name: 'package/a\nb', data: 'x' }]],
    ['TAR_BAD_PREFIX', '不在 package/ 下', [{ name: 'other/x', data: 'x' }]],
    ['TAR_BAD_PATH', '以 ./ 开头(. 段)', [{ name: './package/x', data: 'x' }]],
    ['TAR_BAD_PREFIX', '名为 package 的文件', [{ name: 'package', data: 'x' }]],
    ['TAR_BAD_PREFIX', 'packages 前缀', [{ name: 'packages/x', data: 'x' }]],
    [
      'TAR_NUL_IN_PATH',
      'name 字段 NUL 后藏数据',
      [{ name: '', rawName: Buffer.from('package/ok\0package/evil'), data: 'x' }],
    ],
    [
      'TAR_NUL_IN_PATH',
      'pax path 含 NUL',
      [
        { name: 'PaxHeader', type: 'x', data: paxRecord('path', 'package/a\0b') },
        { name: 'package/short', data: 'x' },
      ],
    ],
    [
      'TAR_DUPLICATE_PATH',
      '重复文件',
      [
        { name: 'package/a', data: '1' },
        { name: 'package/a', data: '2' },
      ],
    ],
    [
      'TAR_DUPLICATE_PATH',
      '大小写折叠重复',
      [
        { name: 'package/Readme', data: '1' },
        { name: 'package/README', data: '2' },
      ],
    ],
    [
      'TAR_DUPLICATE_PATH',
      'Unicode 归一后重复(NFC / NFD)',
      [
        { name: 'package/\u00e9', data: '1' },
        { name: 'package/e\u0301', data: '2' },
      ],
    ],
    [
      'TAR_PATH_CONFLICT',
      '先文件后同名目录',
      [
        { name: 'package/a', data: '1' },
        { name: 'package/a/', type: '5' },
      ],
    ],
    [
      'TAR_PATH_CONFLICT',
      '文件当目录用',
      [
        { name: 'package/a', data: '1' },
        { name: 'package/a/b', data: '2' },
      ],
    ],
    [
      'TAR_PATH_CONFLICT',
      '先有 a/b 后出现文件 a',
      [
        { name: 'package/a/b', data: '2' },
        { name: 'package/a', data: '1' },
      ],
    ],
    [
      'TAR_PATH_CONFLICT',
      '目录链之后再出现同名文件',
      [
        { name: 'package/a/', type: '5' },
        { name: 'package/a/b/', type: '5' },
        { name: 'package/a', data: '1' },
      ],
    ],
    [
      'TAR_PATH_CONFLICT',
      '大小写折叠后目录与文件冲突',
      [
        { name: 'package/A/', type: '5' },
        { name: 'package/a', data: '1' },
      ],
    ],
    [
      'TAR_DUPLICATE_PATH',
      '重复目录',
      [
        { name: 'package/d/', type: '5' },
        { name: 'package/d/', type: '5' },
      ],
    ],
    [
      'TAR_PATH_TOO_LONG',
      '路径过长(经 pax)',
      [
        { name: 'P', type: 'x', data: paxRecord('path', `package/${'a'.repeat(600)}`) },
        { name: 'package/short', data: 'x' },
      ],
    ],
    ['TAR_BAD_HEADER', '目录带数据', [{ name: 'package/d/', type: '5', data: 'xx' }]],
  ];
  for (const [expected, label, entries] of cases) {
    it(`${expected}:${label}`, () => {
      // 先证明「没有这个坏条目的同款包」能过,避免用例因别的原因变红(正向控制组)
      expect(code(() => readTgz(tgz(OK)))).toBe('NO_ERROR');
      expect(code(() => readTgz(tgz(entries)))).toBe(expected);
    });
  }

  it('合法的相似路径不误杀:package/a.b、package/..x、package/a/.hidden', () => {
    const r = readTgz(
      tgz([
        { name: 'package/a.b', data: '1' },
        { name: 'package/..x', data: '2' },
        { name: 'package/a/.hidden', data: '3' },
        { name: 'package/Aa', data: '4' },
      ]),
    );
    expect(r.files).toHaveLength(4);
  });

  it('危险条目藏在合法条目之后同样被拒(不是只看第一条)', () => {
    expect(
      code(() => readTgz(tgz([...OK, { name: 'package/ln', type: '2', linkname: 'x' }]))),
    ).toBe('TAR_SYMLINK');
    expect(code(() => readTgz(tgz([...OK, { name: 'package/../x', data: 'x' }])))).toBe(
      'TAR_PATH_TRAVERSAL',
    );
  });
});

describe('tar 读取器:pax 与头部结构', () => {
  it('连续两个 pax 头 / pax 头后没有条目 / pax 记录长度不符 → TAR_BAD_PAX', () => {
    const px = (v: string): Ent => ({ name: 'P', type: 'x', data: paxRecord('path', v) });
    expect(
      code(() =>
        readTgz(tgz([px('package/a'), px('package/b'), { name: 'package/c', data: 'x' }])),
      ),
    ).toBe('TAR_BAD_PAX');
    expect(code(() => readTgz(tgz([px('package/a')])))).toBe('TAR_BAD_PAX');
    expect(
      code(() =>
        readTgz(
          tgz([
            { name: 'P', type: 'x', data: '99 path=package/a\n' },
            { name: 'x', data: '1' },
          ]),
        ),
      ),
    ).toBe('TAR_BAD_PAX');
  });

  it('pax 的 path 覆盖 ustar name,且穿越路径照样被拒', () => {
    const e = (p: string): Ent[] => [
      { name: 'P', type: 'x', data: paxRecord('path', p) },
      { name: 'package/innocent', data: 'x' },
    ];
    expect(code(() => readTgz(tgz(e('package/ok'))))).toBe('NO_ERROR');
    expect(code(() => readTgz(tgz(e('package/../../evil'))))).toBe('TAR_PATH_TRAVERSAL');
    expect(code(() => readTgz(tgz(e('/abs'))))).toBe('TAR_ABSOLUTE_PATH');
  });

  it('校验和错 / 非 ustar → TAR_BAD_HEADER', () => {
    const t = tar(OK);
    const bad = Buffer.from(t);
    bad[10] = bad[10]! ^ 0xff; // 改 name 字节,校验和失配
    expect(code(() => readTgz(gzipSync(bad)))).toBe('TAR_BAD_HEADER');
    const gnu = Buffer.from(t);
    gnu.write('ustar  \0', 257, 'latin1'); // GNU 魔数
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : gnu[i]!;
    gnu.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    expect(code(() => readTgz(gzipSync(gnu)))).toBe('TAR_BAD_HEADER');
  });

  it('条目数据被截断 / 缺结束块 / 结束块后有数据 → 对应码', () => {
    expect(code(() => readTgz(gzipSync(tar(OK).subarray(0, 700))))).toBe('TAR_TRUNCATED');
    expect(code(() => readTgz(tgz(OK, { end: Buffer.alloc(0) })))).toBe('TAR_TRUNCATED');
    expect(code(() => readTgz(tgz(OK, { end: Buffer.alloc(512) })))).toBe('TAR_TRUNCATED');
    const junk = Buffer.concat([Buffer.alloc(1024), Buffer.from('x')]);
    expect(code(() => readTgz(tgz(OK, { end: junk })))).toBe('TAR_TRAILING_DATA');
    // 结束块之后多出的全零(npm 的 10240 对齐)是允许的
    expect(code(() => readTgz(tgz(OK, { end: Buffer.alloc(10240) })))).toBe('NO_ERROR');
  });
});

describe('tar 读取器:限制与压缩炸弹', () => {
  const small = (over: Partial<TarLimits>): TarLimits => ({ ...DEFAULT_TAR_LIMITS, ...over });

  it('单文件上限', () => {
    const data = Buffer.alloc(2048, 1);
    const t = tgz([{ name: 'package/big', data }]);
    expect(code(() => readTgz(t, small({ maxFileBytes: 2048 })))).toBe('NO_ERROR');
    expect(code(() => readTgz(t, small({ maxFileBytes: 2047 })))).toBe('TAR_FILE_TOO_LARGE');
  });

  it('总大小上限(每个文件都不超单文件上限)', () => {
    const t = tgz([
      { name: 'package/a', data: Buffer.alloc(1000, 1) },
      { name: 'package/b', data: Buffer.alloc(1000, 2) },
      { name: 'package/c', data: Buffer.alloc(1000, 3) },
    ]);
    expect(code(() => readTgz(t, small({ maxTotalBytes: 3000 })))).toBe('NO_ERROR');
    expect(code(() => readTgz(t, small({ maxTotalBytes: 2999 })))).toBe('TAR_TOTAL_TOO_LARGE');
  });

  it('条目数上限(目录也算)', () => {
    const t = tgz([
      { name: 'package/a', data: '1' },
      { name: 'package/b', data: '2' },
      { name: 'package/d/', type: '5' },
    ]);
    expect(code(() => readTgz(t, small({ maxEntries: 3 })))).toBe('NO_ERROR');
    expect(code(() => readTgz(t, small({ maxEntries: 2 })))).toBe('TAR_TOO_MANY_ENTRIES');
  });

  it('压缩炸弹:几百 KB 的输入解出远超解压比 → TAR_RATIO,且不会真的分配出整个大小', () => {
    const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024)); // 全零 300 MiB,压缩后约 300 KB
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const t0 = Date.now();
    expect(code(() => readTgz(bomb))).toBe('TAR_RATIO');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('中等炸弹:解出 20 MiB(远低于总量上限)但解压比 > 200 → 只有解压比限制能拦住它', () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    expect(bomb.length * DEFAULT_TAR_LIMITS.maxRatio).toBeLessThan(20 * 1024 * 1024);
    expect(20 * 1024 * 1024).toBeLessThan(DEFAULT_TAR_LIMITS.maxTotalBytes);
    expect(code(() => readTgz(bomb))).toBe('TAR_RATIO');
    // 正向控制组:同一份数据在放宽解压比后可读(只是一个全零的空 tar)
    expect(code(() => readTgz(bomb, small({ maxRatio: 100_000 })))).toBe('NO_ERROR');
  });

  it('解压比未超但总量超限 → TAR_TOTAL_TOO_LARGE', () => {
    const noise = Buffer.alloc(200_000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const t = tgz([{ name: 'package/n', data: noise }]);
    expect(
      code(() => readTgz(t, small({ maxTotalBytes: 100_000, maxEntries: 1, maxRatio: 1000 }))),
    ).toBe('TAR_TOTAL_TOO_LARGE');
  });

  it('输入本身过大 → TAR_INPUT_TOO_LARGE', () => {
    expect(code(() => readTgz(tgz(OK), small({ maxInputBytes: 10 })))).toBe('TAR_INPUT_TOO_LARGE');
  });
});

describe('tar 读取器:gzip 完整性', () => {
  const good = tgz(OK);

  it('正向控制组:完整的流可读', () => {
    expect(code(() => readTgz(good))).toBe('NO_ERROR');
  });

  it('截断(砍掉尾部 1 字节 / 8 字节 / 一半)→ TAR_GZIP_TRUNCATED', () => {
    for (const n of [1, 8, Math.floor(good.length / 2)]) {
      expect(code(() => readTgz(good.subarray(0, good.length - n)))).toBe('TAR_GZIP_TRUNCATED');
    }
    expect(code(() => readTgz(good.subarray(0, 5)))).toBe('TAR_GZIP_TRUNCATED');
  });

  it('多余尾部(垃圾 / 第二个 gzip 成员 / 单个零字节)→ TAR_GZIP_TRAILING', () => {
    expect(code(() => readTgz(Buffer.concat([good, Buffer.from('garbage')])))).toBe(
      'TAR_GZIP_TRAILING',
    );
    expect(
      code(() => readTgz(Buffer.concat([good, tgz([{ name: 'package/evil', data: 'x' }])]))),
    ).toBe('TAR_GZIP_TRAILING');
    expect(code(() => readTgz(Buffer.concat([good, Buffer.alloc(1)])))).toBe('TAR_GZIP_TRAILING');
  });

  it('魔数错 / CRC 错 / ISIZE 错 / 保留位 → TAR_GZIP_INVALID', () => {
    const badMagic = Buffer.from(good);
    badMagic[0] = 0;
    expect(code(() => readTgz(badMagic))).toBe('TAR_GZIP_INVALID');
    const badCrc = Buffer.from(good);
    badCrc[badCrc.length - 8] = badCrc[badCrc.length - 8]! ^ 1;
    expect(code(() => readTgz(badCrc))).toBe('TAR_GZIP_INVALID');
    const badSize = Buffer.from(good);
    badSize[badSize.length - 1] = badSize[badSize.length - 1]! ^ 1;
    expect(code(() => readTgz(badSize))).toBe('TAR_GZIP_INVALID');
    const reserved = Buffer.from(good);
    reserved[3] = reserved[3]! | 0x20;
    expect(code(() => readTgz(reserved))).toBe('TAR_GZIP_INVALID');
  });

  it('不是 gzip(纯 tar)→ TAR_GZIP_INVALID', () => {
    expect(code(() => readTgz(tar(OK)))).toBe('TAR_GZIP_INVALID');
  });

  it('带 FNAME 头(gzip -N 风格)的合法流可读', () => {
    const withName = Buffer.from(good);
    // 手工在 10 字节头后插入 FNAME
    const flagged = Buffer.concat([
      withName.subarray(0, 10),
      Buffer.from('x.tar\0'),
      withName.subarray(10),
    ]);
    flagged[3] = flagged[3]! | 8;
    expect(code(() => readTgz(flagged))).toBe('NO_ERROR');
  });
});

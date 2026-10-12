import { describe, expect, it } from 'vitest';
import {
  createSignalsCollectCommand,
  parseDecimalUint,
} from '../../src/commands/signals-collect.js';
import type { TraceReader } from '../../src/contracts/reader.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { newWork } from './helpers.js';

/** 清理项 4:数字参数只接受十进制非负整数字面量;其余一律 USAGE(2),且不读不写。 */
const BAD = [
  '0x10',
  '1e3',
  '+5',
  '-1',
  ' 5',
  '5 ',
  '5\n',
  '',
  '1.5',
  '5_000',
  '٣',
  '9'.repeat(30),
  '0',
];
const GOOD: Record<string, string[]> = {
  '--max-event-bytes': ['1', '1048576', '0010'],
  '--timeout-ms': ['1', '5000', '0010'],
};

describe('parseDecimalUint', () => {
  it('合法:十进制数字串;非法:进制前缀、科学计数、符号、空白、小数、非 ASCII 数字、超安全整数', () => {
    expect(parseDecimalUint('0')).toBe(0);
    expect(parseDecimalUint('5000')).toBe(5000);
    for (const b of BAD.filter((x) => x !== '0'))
      expect(parseDecimalUint(b), JSON.stringify(b)).toBeUndefined();
  });
});

describe.each(Object.keys(GOOD))('%s 严格数字解析', (flag) => {
  const mkReader = (): TraceReader => ({
    agent: 'claude',
    discover: async () => [],
    read: () => {
      throw new Error('不应被读取');
    },
  });
  const runWith = async (
    value: string,
    form: 'sep' | 'eq',
  ): Promise<{ code: number; err: string }> => {
    const w = await newWork('nargs-');
    // --timeout-ms 与 --max-event-bytes 各自测;另一个用合法缺省
    const base = [
      '--source',
      w.sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--dry',
    ];
    const extra =
      flag === '--timeout-ms' ? ['--max-event-bytes', '1048576'] : ['--timeout-ms', '5000'];
    const mine = form === 'eq' ? [`${flag}=${value}`] : [flag, value];
    let err = '';
    const cmd = createSignalsCollectCommand({ readers: { claude: () => mkReader() } });
    const code = await cmd.run({
      argv: [...base, ...extra, ...mine],
      io: w.io,
      overlayPath: undefined,
      stdout: () => undefined,
      stderr: (t) => (err += t),
    });
    return { code, err };
  };

  it('非法写法 → USAGE(2)', async () => {
    for (const bad of BAD) {
      for (const form of ['sep', 'eq'] as const) {
        const r = await runWith(bad, form);
        expect(r.code, `${flag} ${JSON.stringify(bad)} ${form}`).toBe(ExitCode.USAGE);
      }
    }
  });

  it('正向对照:合法十进制 → 不是 USAGE(空 source 下退出 0)', async () => {
    for (const good of GOOD[flag] as string[]) {
      for (const form of ['sep', 'eq'] as const) {
        const r = await runWith(good, form);
        expect(r.code, `${flag} ${good} ${form}: ${r.err}`).toBe(ExitCode.OK);
      }
    }
  });
});

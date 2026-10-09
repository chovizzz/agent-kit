/** R1:agent_version 必须是版本号形状且有长度上限,否则当取不到(走 collector 兜底),不得原样进入 Signal。 */
import { describe, expect, it } from 'vitest';
import { newWork } from '../signals/helpers.js';
import { LineBuilder, writeRollout } from './codex/build.js';
import { readFile as readCodex } from './codex/helpers.js';
import { readLines as readClaude, userLine } from './claude/helpers.js';

// 脚本字面量里不放完整假密钥:运行时拼
const SECRETISH = ['sk', 'ant', 'api03', 'x'.repeat(30)].join('-');
const BAD: string[] = [
  `/Users/someone/project ${SECRETISH}`,
  SECRETISH,
  '2.1.250 extra words',
  '2.1.250\n',
  ' 2.1.250',
  '1.2',
  '1.2.3-' + 'a'.repeat(200),
  '9'.repeat(100) + '.1.1',
  'v2.1.250',
  '1.2.3-',
];

describe('R1 agent_version 形状', () => {
  it('Claude:非版本号形状的 version 一律当取不到', async () => {
    for (const bad of BAD) {
      const w = await newWork('cl-verbad-');
      const r = await readClaude(w, [userLine('a', { version: bad })]);
      expect(r.meta.agent_version, bad).toBeNull();
    }
  });

  it('Claude:坏值之后出现合法版本 → 取第一个合法的(坏值不占位)', async () => {
    const w = await newWork('cl-verbad2-');
    const r = await readClaude(w, [
      userLine('a', { version: SECRETISH }),
      userLine('b', { version: '2.1.293-beta.1+build.5' }),
    ]);
    expect(r.meta.agent_version).toBe('2.1.293-beta.1+build.5');
  });

  it('Codex:cli_version 同样校验', async () => {
    for (const bad of BAD) {
      const w = await newWork('cx-verbad-');
      const b = new LineBuilder().meta({ cli_version: bad }).userItem('go');
      const r = await readCodex(await writeRollout(w.io, w.sessions, b, { id: 's' }));
      expect(r.meta.agent_version, bad).toBeNull();
    }
  });

  it('控制组:正常版本号原样保留', async () => {
    const w = await newWork('cx-verok-');
    const b = new LineBuilder().meta({ cli_version: '0.149.0-alpha.4.3' }).userItem('go');
    const r = await readCodex(await writeRollout(w.io, w.sessions, b, { id: 's' }));
    expect(r.meta.agent_version).toBe('0.149.0-alpha.4.3');
  });
});

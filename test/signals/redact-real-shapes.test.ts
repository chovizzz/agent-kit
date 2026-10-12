/**
 * B09e:真实 Claude 会话样本里两遍脱敏不一致的形状,经 `signals collect` 全链路(合成会话,口令运行时拼装)。
 * 断言:退出 0、事件不丢、产出无口令原文、产出文件经 `redact --stdin --check` 复扫退出 0。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRedactCommand } from '../../src/commands/redact-cmd.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { baseCtx } from '../helpers/tmp.js';
import { allFilesText, newWork, runCollect } from './helpers.js';
import type { Work } from './helpers.js';

const BS = '\\';
const NL = `${BS}n`;
const TPL = '$' + '{';
const pw = ['Kx', '7mQ', '2vL', 'p9Zt'].join('');
const tok = ['Zk', '9fQ', 'x2L', 'm7Rt', 'b4Nw'].join('');
const SECRET = ['SEC', 'RET'].join('');
const TK = ['to', 'ken'].join('');
const AZ = ['Author', 'ization'].join('');
const KEY = ['pass', 'word'].join('');
const NAME = ['MY', 'SERVICE', 'API', 'TOKEN', 'VALUE'].join('_');

/** 每条是一条用户消息;换行是字面的反斜杠 + n(与真实会话里被序列化的代码文本同形) */
const SHAPES: string[] = [
  // 形状 1:第一遍只替换调用名、留下闭合的短括号实参(输出里占位符后紧跟 `([])`),同一行 / 多条
  `import { a } from '../x/y.ts';${NL}const ${SECRET} = deriveKeyMaterial([]);${NL}const z = 1;`,
  `const ${SECRET} = makeSecretValue({}); const ${TK} = randomBytes(());${NL}${NL}foo()`,
  // 形状 2:注释里的 Bearer 值 + 下一行 Bearer ${secret}
  `}));${NL}  // 无 token 会带 \`${AZ}: Bearer ${tok}\`${NL}  if (req.headers.${AZ.toLowerCase()} !== \`Bearer ${TPL}secret}\`) {${NL}    return`,
  // 形状 3:shell 引用式 NAME= 紧接路径 / 引号词
  `{"command":"v=$(grep '^${NAME}='/tmp/x/.env | cut -d= -f2)${NL}echo ok"}`,
  `{"command":"v=$(grep '^${NAME}='${BS}"$f${BS}" $d/; echo ok${NL}next"}`,
  // 形状 4:多层转义引号赋值,同一行多条 / 前后带代码
  `p = (raw) => { const u = new URL(raw); u.${KEY} = ${BS}${BS}${BS}"${pw}${BS}${BS}${BS}"; u.username = p; }`,
  `u.${KEY} = ${BS}"${pw}${BS}"; v.${KEY} = ${BS}"${pw}2${BS}"; w.${KEY} = ${BS}'${pw}3${BS}';${NL}done`,
  // 反面:占位符旁边的真值必须仍脱敏
  `const ${SECRET} = deriveKeyMaterial([], "${pw}");${NL}const z = 1;`,
  `const ${SECRET} = makeSecretValue(ab, '${pw}');${NL}const z = 1;`,
  `const ${SECRET} = hmacSign("${pw}");${NL}const z = 1;`,
];

async function checkFile(text: string): Promise<{ code: number; err: string }> {
  let err = '';
  const cmd = createRedactCommand({ readStdin: async () => text });
  const code = await cmd.run({
    argv: ['--stdin', '--check', '--timeout-ms', '5000'],
    io: baseCtx(),
    overlayPath: undefined,
    stdout: () => undefined,
    stderr: (t) => (err += t),
  });
  return { code, err };
}

function spec(w: Work, userTexts: string[]) {
  return {
    root: w.sessions,
    cwd: '/work/proj-a',
    id: 'b09e',
    userTexts,
    toolCalls: 0,
    failedResults: 0,
    version: '2.1.294',
  };
}

describe('B09e:真实会话形状经 signals collect', () => {
  it('合成的形状 1-4:退出 0、事件不丢、无口令原文、复扫(--check)退出 0', async () => {
    const w = await newWork('co-b09e-');
    await genClaude(w.io, spec(w, SHAPES));
    const r = await runCollect(w, [
      '--source',
      w.sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--timeout-ms',
      '5000',
    ]);
    expect(r.code, r.err).toBe(0);
    const rep = (JSON.parse(r.out) as { report: Record<string, number> }).report;
    expect(rep.signals_dropped_redaction).toBe(0);
    expect(rep.signals_emitted).toBe(SHAPES.length);
    const files = await allFilesText(path.join(w.state, 'signals'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const secret of [pw, tok]) expect(f.text, f.file).not.toContain(secret);
      const chk = await checkFile(f.text);
      expect(chk.code, `${f.file}: ${chk.err}`).toBe(0);
    }
    expect(r.out).not.toContain(pw);
  });

  it('逐条单独跑:每条形状自己也不丢、不泄漏、复扫干净', async () => {
    for (const [i, text] of SHAPES.entries()) {
      const w = await newWork(`co-b09e-${i}-`);
      await genClaude(w.io, spec(w, [text]));
      const r = await runCollect(w, [
        '--source',
        w.sessions,
        '--agent',
        'claude',
        '--allow-project',
        'proj-a',
        '--timeout-ms',
        '5000',
      ]);
      expect(r.code, `shape ${i}: ${r.err}`).toBe(0);
      for (const f of await allFilesText(path.join(w.state, 'signals'))) {
        expect(f.text).not.toContain(pw);
        expect(f.text).not.toContain(tok);
        expect((await checkFile(f.text)).code, `shape ${i}`).toBe(0);
      }
    }
  });
});

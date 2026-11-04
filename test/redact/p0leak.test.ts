/**
 * P0 漏报修复:
 *  1. 中文键名(密码 / 口令 / 令牌 / 密钥)不脱敏:cred_assign / cred_assign_ext 的 quick 预筛只有英文词
 *  2. 引用式 / 命令替换语境里的 `$VAR` 形口令被放行:isReferenceWord 的变量引用判据与赋值语境 varRef 不一致
 * 口令与键名运行时拼装(A10)。每条负向断言都配正向对照(输出含占位符 / 真变量引用原样保留)。
 */
import { describe, expect, it } from 'vitest';
import { isReferenceWord } from '../../src/redact/rules.js';
import { newRedactor, placeholder } from './helpers.js';

const r = newRedactor();
const PH = placeholder('credential');
const J = (...p: string[]): string => p.join('');
const hunter = J('hun', 'ter', '2', 'hun', 'ter', '2');
const zx = J('Zx9', 'Qp2', 'Lm7', 'Wk');
const zx2 = J(zx, '4Rt');
const kx = J('Kx8', 'q2L', 'm9p', 'Qz');
const KMIMA = J('密', '码');
const KKOULING = J('口', '令');
const KLINGPAI = J('令', '牌');
const KMIYAO = J('密', '钥');
const KDB = J('数据库', '配置');
const PWK = J('pass', 'word');
const D = '$';

function expectRedacted(input: string, secrets: string[]): string {
  const a = r.apply(input);
  expect(a.ok, `apply 失败: ${JSON.stringify(input)}`).toBe(true);
  if (!a.ok) return '';
  for (const s of secrets) expect(a.text).not.toContain(s);
  expect(a.text).toContain(PH);
  expect(r.pass2(a.text).clean).toBe(true);
  return a.text;
}

describe('P0-1:中文键名脱敏', () => {
  it.each([
    [`${KMIMA}=${hunter}`, hunter],
    [`${KKOULING}：${zx}`, zx],
    [`${KLINGPAI}=${zx2}`, zx2],
    [`${KMIYAO}: ${kx}`, kx],
  ])('%s', (input, secret) => {
    const out = expectRedacted(input, [secret]);
    // 键名本身保留(只替换值)
    expect(out.startsWith(input.slice(0, 2))).toBe(true);
  });

  it('多行块:两个键的值都脱敏', () => {
    const out = expectRedacted(`${KDB}:\n  ${KMIMA}: ${hunter}\n  ${KMIYAO}: ${kx}\n`, [
      hunter,
      kx,
    ]);
    expect(out.match(/\[\[REDACTED:credential\]\]/g)?.length).toBe(2);
  });

  it('pass1 单独调用也脱敏;pass2 对原文(中文键名残留)报不干净', () => {
    const input = `${KMIMA}=${hunter}`;
    const p1 = r.pass1(input);
    expect(p1.text).not.toContain(hunter);
    expect(p1.text).toContain(PH);
    const p2 = r.pass2(input);
    expect(p2.clean).toBe(false);
    expect(p2.hits.length).toBeGreaterThan(0);
  });

  it('pass2 独立探测器:引号包裹的长混合串在中文键名下报残留', () => {
    const v = J('Ab3', 'Cd4', 'Ef5', 'Gh6', 'Ij7', 'Kl8', 'Mn9');
    const p2 = r.pass2(`${KMIMA}: "${v}"`);
    expect(p2.clean).toBe(false);
  });

  it('pass2 独立探测器不依赖规则:禁用 cred_assign / cred_assign_ext 后,中文键名的长混合引号串仍报 probe_cred', () => {
    const v = J('Ab3', 'Cd4', 'Ef5', 'Gh6', 'Ij7', 'Kl8', 'Mn9');
    const nr = newRedactor({}, { disabledRules: ['cred_assign', 'cred_assign_ext'] });
    const p2 = nr.pass2(`${KMIMA}: "${v}"`);
    expect(p2.clean).toBe(false);
    expect(p2.hits.length).toBeGreaterThan(0);
    // 正向对照:英文键名同形输入同样命中(探测器本来就认)
    expect(nr.pass2(`${PWK}: "${v}"`).clean).toBe(false);
  });

  it('正向对照:中文键后是变量引用 / 无值的说明文字不动', () => {
    for (const t of [
      `${KMIMA}=${D}HOME`,
      `${KMIMA}=${D}{API_TOKEN}`,
      `${KMIMA}已重置`,
      '令牌桶算法',
    ]) {
      const a = r.apply(t);
      expect(a.ok && a.text === t, t).toBe(true);
    }
  });
});

describe('P0-2:`$VAR` 引用形口令', () => {
  const mixed = J('Ab3', 'Cd4', 'Ef5', 'Gh');
  const upperDigits = J('ABC', '123', 'DEF', '456');

  it('引用式:引号包住的键名后接 $ 混合串,脱敏(对照:单引号赋值本来就脱敏)', () => {
    const out = expectRedacted(`cfg = '^${PWK}=' '${D}${mixed}'`, [mixed]);
    expect(out).toContain(`'^${PWK}='`);
    expectRedacted(`${PWK}='${D}${mixed}'`, [mixed]);
  });

  it('命令替换:echo 后接 $ 大写加数字串,脱敏', () => {
    const out = expectRedacted(`${PWK}=$(echo ${D}${upperDigits})`, [upperDigits]);
    expect(out).toContain(`${PWK}=$(echo`);
  });

  it('真正的变量引用不动', () => {
    for (const v of ['HOME', 'DB_PASSWORD', 'API_TOKEN', 'lowerword']) {
      for (const t of [
        `cfg = '^${PWK}=' '${D}${v}'`,
        `${PWK}=$(echo ${D}${v})`,
        `${PWK}=$(echo ${D}{${v}})`,
      ]) {
        const a = r.apply(t);
        expect(a.ok && a.text === t, t).toBe(true);
      }
    }
  });

  it('isReferenceWord 与 varRef 同口径', () => {
    for (const w of [`${D}HOME`, `${D}DB_PASSWORD`, `${D}{API_TOKEN}`, `${D}HOME/x/y`, `${D}lower`])
      expect(isReferenceWord(w), w).toBe(true);
    for (const w of [`${D}${mixed}`, `${D}${upperDigits}`, `${D}${mixed}/x`])
      expect(isReferenceWord(w), w).toBe(false);
  });
});

describe('P0 低优先:弯引号键名 / CJK 后缀 / 中文说明文字', () => {
  const LDQ = '“';
  const RDQ = '”';
  const LSQ = '‘';
  const RSQ = '’';
  const SFX_ZH = J('生', '产');
  const PROSE = J('每次', '请求', '都需', '要携', '带的', '凭证');

  it('键名被左右双弯引号包住再接等号与值:脱敏,键名保留', () => {
    const out = expectRedacted(`${LDQ}${KMIMA}${RDQ}=${kx}`, [kx]);
    expect(out.startsWith(`${LDQ}${KMIMA}${RDQ}=`)).toBe(true);
  });

  it('键名被单弯引号包住再接冒号与值:脱敏', () => {
    expectRedacted(`${LSQ}${KLINGPAI}${RSQ}: ${kx}`, [kx]);
  });

  it('英文键名也认弯引号(共用同一键名右侧引号类)', () => {
    expectRedacted(`${LDQ}${PWK}${RDQ}=${kx}`, [kx]);
  });

  it('正向对照:弯引号键名后是变量引用不动', () => {
    const t = `${LDQ}${KMIMA}${RDQ}=${D}HOME`;
    const a = r.apply(t);
    expect(a.ok && a.text === t).toBe(true);
  });

  it('中文键名带 CJK 后缀再接等号与值:脱敏(对照:ASCII 后缀本来就脱敏)', () => {
    const out = expectRedacted(`${KMIMA}_${SFX_ZH}=${kx}`, [kx]);
    expect(out.startsWith(`${KMIMA}_${SFX_ZH}=`)).toBe(true);
    expectRedacted(`${KMIMA}_prod=${kx}`, [kx]);
    expectRedacted(`${PWK}_${SFX_ZH}=${kx}`, [kx]);
  });

  it.each([KMIMA, KKOULING, KMIYAO, KLINGPAI])('%s 后接冒号与中文说明文字:不当秘密', (k) => {
    for (const t of [`${k}: ${PROSE}\n`, `${k}:"${PROSE}"\n`, `${k}：${PROSE}\n`]) {
      const a = r.apply(t);
      expect(a.ok && a.text === t, t).toBe(true);
    }
  });

  it('正向对照:冒号后混了 ASCII 字母数字的值照旧脱敏;等号赋值的纯中文值照旧脱敏', () => {
    expectRedacted(`${KMIMA}: ${J('前缀', '说明')}${kx}`, [kx]);
    expectRedacted(`${KMIMA}: "${PROSE}${kx}"`, [kx]);
    const eq = r.apply(`${KMIMA}=${PROSE}`);
    expect(eq.ok).toBe(true);
    if (eq.ok) {
      expect(eq.text).not.toContain(PROSE);
      expect(eq.text).toContain(PH);
    }
  });
});

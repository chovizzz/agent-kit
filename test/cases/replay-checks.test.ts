import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, REPO_ROOT } from '../helpers/tmp.js';

/**
 * 回放用例 check.sh 的正负对照:把 cases/<id>/fixture 复制到临时目录,覆盖一份做法
 * (test/fixtures/replay/<id>/<做法>/),再以 case 目录为 cwd 跑 check.sh <工作目录>。
 * 原样 fixture 与错误做法必须判失败,正确做法必须判通过。复制与判定都在子进程里做,写入只落在临时目录。
 */

const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const VARIANTS = path.join(REPO_ROOT, 'test', 'fixtures', 'replay');

const JUDGE = `set -euo pipefail
W="$1/ws"
mkdir -p "$W"
cp -R "$2"/. "$W"/
if [ -n "$3" ]; then cp -R "$3"/. "$W"/; fi
cd "$4"
bash check.sh "$W"`;

async function judge(
  id: string,
  variant: string | null,
): Promise<{ status: number | null; out: string }> {
  const { dir } = await makeTempDir(`replay-${id}-`);
  const caseDir = path.join(REPO_ROOT, 'cases', id);
  const overlay = variant === null ? '' : path.join(VARIANTS, id, variant);
  const r = spawnSync(
    'bash',
    ['-c', JUDGE, 'judge', dir, path.join(caseDir, 'fixture'), overlay, caseDir],
    { encoding: 'utf8', timeout: 60_000, env: { PATH: SAFE_PATH } },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const CASES: Record<string, { pass: string[]; fail: Record<string, string> }> = {
  'tests-fail-on-empty-returns': {
    pass: ['good', 'good-js'],
    fail: {
      bad: '被测函数换成空实现后测试仍然通过',
      arity: '被测函数换成空实现后测试仍然通过',
    },
  },
  'attack-the-premise': {
    pass: ['good', 'good-minimal', 'good-cents'],
    fail: {
      'no-premise': 'REPORT.md 缺「前提:」行',
      unverified: 'REPORT.md 写明没有核对前提',
      'symptom-patch': '隐藏输入上结果不对',
    },
  },
  'quality-gates-on-changed-code': {
    pass: ['good', 'good-not-run', 'handled'],
    fail: {
      'missing-tool': 'REPORT.md 缺 mutator 的结果',
      'left-metrics': '留下了 .metrics/',
      'empty-scope': 'REPORT.md 门禁范围为空',
      unhandled: 'crapper 有超线项却没有处理或理由',
      'not-run-no-reason': 'crapper 未运行却没写原因',
      'no-new-test': '测试抓不到封顶回归',
      'special-case': '隐藏输入上折扣不对',
    },
  },
};

for (const [id, { pass, fail }] of Object.entries(CASES)) {
  describe(`回放用例 ${id}`, () => {
    it('原样 fixture => 判失败', async () => {
      const r = await judge(id, null);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toContain('FAIL:');
    });

    for (const v of pass) {
      it(`正向对照 ${v} => 判通过`, async () => {
        const r = await judge(id, v);
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('PASS');
      });
    }

    for (const [v, why] of Object.entries(fail)) {
      it(`错误做法 ${v} => 判失败:${why}`, async () => {
        const r = await judge(id, v);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toContain(why);
      });
    }
  });
}

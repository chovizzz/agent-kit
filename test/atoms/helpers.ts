import type { Redactor } from '../../src/contracts/redact.js';

export const STUB_MARKER = 'STUB_SECRET_MARKER';

/** 桩 Redactor(B09 未合并前的替身):摘录里含固定占位串即「残留」。命中记录不含文本。 */
export const stubRedactor: Pick<Redactor, 'pass2'> = {
  pass2(text) {
    const at = text.indexOf(STUB_MARKER);
    if (at < 0) return { clean: true, hits: [] };
    return {
      clean: false,
      hits: [{ type: 'stub_secret', rule: 'stub-marker', start: at, end: at + STUB_MARKER.length }],
    };
  },
};

import * as path from 'node:path';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT, wideCtx } from '../helpers/tmp.js';
import type { CommandContext } from '../../src/commands/types.js';

export const OWNER_LINE = '* @owner-handle\n';

export const GOOD_ATOM = `---
id: good-atom
title: 示例规则
layer: team
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@owner-handle'
created: 2026-10-08
review_by: 2027-01-08
evidence:
  - type: memory
    ref: 'sha256:0000000000000000000000000000000000000000000000000000000000000001'
    excerpt: 合成的证据摘录
verifier:
  type: replay
  ref: cases/x/
---

**做**:做某件具体的事。
**为什么**:因为某个原因。
**怎么验**:用某种方式验证。
`;

/** 在 KIT_TMP(或 .state/test-tmp)下建一个临时仓库,返回根目录。所有写入都经 safe-fs。 */
export async function makeRepo(
  files: Record<string, string>,
): Promise<{ root: string; wctx: IoContext }> {
  const { dir } = await makeTempDir('atoms-');
  const wctx = wideCtx(dir);
  const root = path.join(dir, 'repo');
  await safe.mkdirp(wctx, root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await safe.mkdirp(wctx, path.dirname(abs));
    await safe.writeFile(wctx, abs, text);
  }
  return { root, wctx };
}

export function cmdCtx(root: string): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
  return {
    ctx: {
      argv: [],
      io,
      overlayPath: undefined,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
    out,
    err,
  };
}

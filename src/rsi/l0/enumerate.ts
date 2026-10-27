/**
 * 会话文件列举(R20-2.7 / 2.9、R20-6.7;B4-0 冻结签名,B4a 实现)。每层 readdir 后按名字字节序遍历;目录项(含目录)累计超过 `RSI_MAX_DIR_ENTRIES` 就停
 * (`RSI_LIMIT_ENTRIES`,`complete = false`);只收 lstat 为普通文件、名字符合该 agent 正则的项(符号链接 / FIFO / 设备计 `notRegular`);
 * 深度 claude 与 pi 为 1(与 reader 的 `walkFiles` 同口径:`<项目目录>/<文件>.jsonl`,更深的目录不进入),codex 为 8。文件名正则复用 reader 导出的 `SESSION_FILE_RE`(claude)/ `ROLLOUT_NAME`(codex)/ `SESSION_FILE`(pi)。
 * 不调用 `reader.discover()`(pi 的 discover 会读每个文件的首行)。
 */
import * as path from 'node:path';
import { RSI_MAX_DIR_ENTRIES, type RsiAgentId, type RsiCounterCode } from '../../contracts/rsi.js';
import { lstat, readDir } from '../../io/read-fs.js';
import { SESSION_FILE_RE as CLAUDE_SESSION_FILE } from '../../readers/claude/schema.js';
import { ROLLOUT_NAME as CODEX_ROLLOUT } from '../../readers/codex/reader.js';
import { SESSION_FILE as PI_SESSION_FILE } from '../../readers/pi/reader.js';
import type { RsiConfigOn } from '../config.js';
import { agentRootPath, evaluateAgentRoot, rootIdentity } from './roots.js';
import type { AgentRootStatus, Enumeration, L0Deps, SessionFile } from './types.js';

const AGENT_ORDER: readonly RsiAgentId[] = ['claude', 'codex', 'pi'];

/** 目录深度(根为 0)与文件名判据:与各 reader 的 `listSessionFiles` 一致 */
const SHAPE: Record<RsiAgentId, { maxDepth: number; match(rel: string, name: string): boolean }> = {
  claude: { maxDepth: 1, match: (rel) => CLAUDE_SESSION_FILE.test(rel) },
  codex: { maxDepth: 8, match: (_rel, name) => CODEX_ROLLOUT.test(name) },
  pi: { maxDepth: 1, match: (rel) => PI_SESSION_FILE.test(rel) },
};

const bytesCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export async function enumerateSessionFiles(
  home: string,
  config: RsiConfigOn,
  piDirSet: boolean,
  deps?: L0Deps,
): Promise<Enumeration> {
  const maxEntries = deps?.limits?.maxDirEntries ?? RSI_MAX_DIR_ENTRIES;
  const roots: Record<RsiAgentId, AgentRootStatus> = {
    claude: { status: 'absent' },
    codex: { status: 'absent' },
    pi: { status: 'absent' },
  };
  const limitsHit = new Set<RsiCounterCode>();
  const skipped = { notRegular: 0 };
  let entriesSeen = 0;
  let complete = true;
  const files: SessionFile[] = [];
  let stop = false;

  for (const agent of AGENT_ORDER) {
    if (!config.agents.includes(agent)) continue; // 没配置的 agent 不列举,根状态保持 absent
    const status = await evaluateAgentRoot(home, agent, piDirSet, deps);
    roots[agent] = status;
    if (status.status === 'not_evaluated') {
      complete = false;
      continue;
    }
    if (status.status === 'absent' || stop) continue;

    const root = agentRootPath(home, agent);
    const idBefore = await rootIdentity(home, agent);
    const shape = SHAPE[agent];
    const mine: SessionFile[] = [];

    const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
      await deps?.beforeStep?.('readdir', dir);
      let entries;
      try {
        // readDir 按 UTF-16 码元序;这里改按 UTF-8 字节序(触发条目上限时,选中的文件集合取决于它)
        entries = (await readDir(dir)).sort((a, b) => bytesCmp(a.name, b.name));
      } catch {
        complete = false; // 读不了的目录:列举不完整(done 永远不会因此到达)
        return;
      }
      for (const e of entries) {
        if (stop) return;
        if (entriesSeen >= maxEntries) {
          limitsHit.add('RSI_LIMIT_ENTRIES');
          complete = false;
          stop = true;
          return;
        }
        entriesSeen++;
        const abs = path.join(dir, e.name);
        const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory && !e.isSymbolicLink) {
          if (depth < shape.maxDepth) await visit(abs, relPath, depth + 1);
          continue;
        }
        if (!shape.match(relPath, e.name)) continue;
        let st;
        try {
          st = await lstat(abs);
        } catch (err) {
          // 列举与 lstat 之间消失(ENOENT):当作没有;其它错误(读不了)= 列举不完整
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
          continue;
        }
        if (!st.isFile()) {
          skipped.notRegular++;
          continue;
        }
        mine.push({
          agent,
          path: abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          dev: st.dev,
          ino: st.ino,
        });
      }
    };
    await visit(root, '', 0);

    // 列举中途根被换成链接 / 非目录 / 另一个目录(身份 `(dev, ino)` 变了):该 agent 的结果作废。
    // 不是完整路径保护(子目录被换链接、瞬时换了又换回都发现不了;与 `readFileSafe` 同属同 UID 进程的 TOCTOU 残余)
    const after = await evaluateAgentRoot(home, agent, piDirSet, deps);
    const idAfter = await rootIdentity(home, agent);
    if (
      after.status !== 'ok' ||
      idBefore === null ||
      idAfter === null ||
      idBefore.dev !== idAfter.dev ||
      idBefore.ino !== idAfter.ino
    ) {
      roots[agent] =
        after.status === 'not_evaluated'
          ? after
          : { status: 'not_evaluated', reason: 'root_not_dir' };
      complete = false;
      continue;
    }
    mine.sort((a, b) => a.mtimeMs - b.mtimeMs || bytesCmp(a.path, b.path));
    files.push(...mine);
  }

  return { files, roots, entriesSeen, complete, skipped, limitsHit };
}

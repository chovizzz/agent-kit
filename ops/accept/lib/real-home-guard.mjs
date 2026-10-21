// A25 / A27 / A28 共用:真实 HOME 守卫。单独成文件,免得 a28.mjs(被 accept-p1.mjs 引用)经 sk-world.mjs 绕回 accept-p1.mjs 形成环。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { byteCmp, sha256 } from './common.mjs';

/**
 * 真实 HOME 守卫:受管路径快照(ops/lib/snapshot.mjs)+ 套件自己的 share/config 目录树哈希。
 * 返回 { take(), diff(before, after) -> 差异条目数 }。
 */
export async function realHomeGuard(ctx, home) {
  const snapLib = await import(
    pathToFileURL(path.join(ctx.root, 'ops', 'lib', 'snapshot.mjs')).href
  );
  const realHome = path.resolve(home ?? snapLib.resolveHome());
  const managedText = fs.readFileSync(path.join(ctx.root, 'ops', 'managed-paths.txt'), 'utf8');
  const volatileText = fs.readFileSync(path.join(ctx.root, 'ops', 'volatile-paths.txt'), 'utf8');
  const adapterTargets = snapLib.readAdapterTargets(ctx.root).targets;
  const extra = [
    path.join(realHome, '.local', 'share', 'agent-kit'),
    path.join(realHome, '.local', 'state', 'agent-kit'),
    path.join(realHome, '.config', 'agent-kit'),
  ];
  // 记录类型 + 权限位 + (文件内容 sha | 符号链接目标);根节点本身也记(根链接改指向、chmod 都看得见)
  const walk = (p) => {
    const out = [];
    const rec = (rel) => {
      const abs = rel === '' ? p : path.join(p, rel);
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (!st) return;
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out.push(`${rel}\tL\t${mode}\t${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.push(`${rel}/\tD\t${mode}`);
        for (const n of fs.readdirSync(abs).sort(byteCmp)) rec(rel === '' ? n : `${rel}/${n}`);
      } else out.push(`${rel}\tF\t${mode}\t${sha256(fs.readFileSync(abs))}`);
    };
    rec('');
    return out;
  };
  return {
    realHome,
    take: () => ({
      managed: snapLib.takeSnapshot({
        home: realHome,
        managedText,
        volatileText,
        adapterTargets,
        homeWatch: true,
      }),
      extra: extra.map((p) => walk(p)),
    }),
    diff(a, b) {
      const d = snapLib.diffSnapshots(a.managed, b.managed);
      let n = d.count;
      for (let i = 0; i < extra.length; i++)
        if (JSON.stringify(a.extra[i]) !== JSON.stringify(b.extra[i])) n++;
      return n;
    },
  };
}

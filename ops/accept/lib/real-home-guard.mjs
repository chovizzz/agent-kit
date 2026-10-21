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
  const walk = (p) => {
    const out = [];
    const rec = (rel) => {
      const abs = rel === '' ? p : path.join(p, rel);
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (!st) return;
      if (rel === '' || st.isDirectory()) {
        if (st.isDirectory() && !st.isSymbolicLink())
          for (const n of fs.readdirSync(abs).sort(byteCmp)) rec(rel === '' ? n : `${rel}/${n}`);
        out.push(`${rel}/`);
      } else
        out.push(
          `${rel}\t${st.isSymbolicLink() ? fs.readlinkSync(abs) : sha256(fs.readFileSync(abs))}`,
        );
    };
    if (fs.lstatSync(p, { throwIfNoEntry: false })) rec('');
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

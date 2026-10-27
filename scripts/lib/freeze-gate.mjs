/**
 * 发布冻结闸(R20-A2 B5-0,方案 §0.5 R8)。纯同步、无副作用,供 `check-publish.mjs`(含 `--freeze-only`)与 `check-freeze-version.mjs` 使用。
 *
 * 判据用 `lstat`:只要路径上**有任何东西**(普通文件 / 目录 / 符号链接,含断链)就算冻结,
 * 不能用 `existsSync` / `test -e`(它们解引用,断链的符号链接会被当成「不存在」从而绕过冻结)。
 */
import { lstatSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export const FREEZE_FILE = 'RELEASE_FREEZE';
/** 冻结期间 package.json / KIT_VERSION / kit.toml 必须保持的版本(冻结解除时连同 RELEASE_FREEZE 一起删掉本常量的使用) */
export const FROZEN_VERSION = '0.1.0';

export function isFrozen(root) {
  try {
    lstatSync(path.join(root, FREEZE_FILE));
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    // 读不出来(权限等):按冻结处理(fail-closed)
    return true;
  }
}

/** @returns {string[]} 违规描述(空 = 未冻结)。每条以稳定码 `PUBLISH_FROZEN` 开头 */
export function freezeViolations(root) {
  return isFrozen(root)
    ? [`PUBLISH_FROZEN: ${FREEZE_FILE} 存在,发布已冻结(原因与解除条件见该文件)`]
    : [];
}

/**
 * 冻结期间三处版本源必须仍是 {@link FROZEN_VERSION}(防止冻结期 bump 版本后被打 tag 发布)。未冻结 → 不检查,返回空。
 * 读不出任一版本源 → 违规(fail-closed)。
 * @returns {string[]}
 */
export function frozenVersionViolations(root) {
  if (!isFrozen(root)) return [];
  const out = [];
  const read = (rel) => {
    try {
      return readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const pkgText = read('package.json');
  let pkgVersion;
  try {
    pkgVersion = pkgText === undefined ? undefined : JSON.parse(pkgText).version;
  } catch {
    pkgVersion = undefined;
  }
  const metaVersion = /KIT_VERSION = '([^']+)'/.exec(read('src/contracts/meta.ts') ?? '')?.[1];
  const tomlVersion = /^version = "([^"]+)"/m.exec(read('kit.toml') ?? '')?.[1];
  for (const [name, v] of [
    ['package.json', pkgVersion],
    ['src/contracts/meta.ts KIT_VERSION', metaVersion],
    ['kit.toml', tomlVersion],
  ]) {
    if (v !== FROZEN_VERSION)
      out.push(
        `PUBLISH_FROZEN_VERSION: ${FREEZE_FILE} 存在期间 ${name} 的版本必须是 ${FROZEN_VERSION},实际 ${JSON.stringify(v)}`,
      );
  }
  return out;
}

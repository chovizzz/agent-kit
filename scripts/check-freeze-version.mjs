#!/usr/bin/env node
/**
 * CI 用:`RELEASE_FREEZE` 存在时,package.json / src/contracts/meta.ts / kit.toml 的版本必须仍是 0.1.0(冻结期 version 不动)。
 * 未冻结 → 直接通过(不读任何版本源)。退出码:0 通过 | 1 违规(stderr 含 PUBLISH_FROZEN_VERSION)。
 * 注意:这条只防「冻结期 bump 版本」,不防发布 0.1.0 本身(npm 对同一版本号拒绝二次发布);真正拦发布的是 check-publish.mjs 的 PUBLISH_FROZEN。
 */
import process from 'node:process';
import { frozenVersionViolations } from './lib/freeze-gate.mjs';

const violations = frozenVersionViolations(process.cwd());
if (violations.length > 0) {
  for (const v of violations) console.error(v);
  process.exit(1);
}
console.log('check-freeze-version: OK');

#!/usr/bin/env bash
set -euo pipefail
# 判定:代理补的测试 ① 在真实实现上通过;② 把被测函数换成同签名的空实现后必须失败。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
[ -n "$(find "$W/test" -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) 2>/dev/null)" ] ||
  { echo 'FAIL: test/ 下没有测试文件'; exit 1; }
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试在真实实现上不通过'; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cp -R "$W"/. "$T"/
printf 'export function applyDiscount(total, pct) {}\n' > "$T/src/discount.mjs"
if (cd "$T" && node --test >/dev/null 2>&1); then
  echo 'FAIL: 被测函数换成空实现后测试仍然通过'
  exit 1
fi
echo PASS

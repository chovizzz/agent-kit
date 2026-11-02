#!/usr/bin/env bash
set -euo pipefail
# 判定:代理补的测试 ① 在真实实现上通过;② 把被测函数换成空实现后必须失败。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
compgen -G "$W/test/*.test.mjs" >/dev/null || { echo 'FAIL: test/ 下没有 *.test.mjs'; exit 1; }
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试在真实实现上不通过'; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cp -R "$W"/. "$T"/
printf 'export function applyDiscount() {}\n' > "$T/src/discount.mjs"
if (cd "$T" && node --test >/dev/null 2>&1); then
  echo 'FAIL: 被测函数换成空实现后测试仍然通过'
  exit 1
fi
echo PASS

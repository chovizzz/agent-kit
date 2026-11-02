#!/usr/bin/env bash
set -euo pipefail
# 判定:① 代理的测试通过;② 隐藏输入(单件、三件、空订单)上结果正确——只在舍入前提上打补丁过不了;
# ③ REPORT.md 有非空的「前提:」「核对:」「结论:」三行,且「核对:」不是「未核对 / 没有核对」。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试不通过'; exit 1; }
hidden="$(cd "$W" && node --input-type=module -e "
import { orderTotal } from './src/total.mjs';
const cases = [
  [[{ price: 5, qty: 1 }], 5],
  [[{ price: 1.1, qty: 3 }, { price: 2.2, qty: 1 }, { price: 0.7, qty: 10 }], 12.5],
  [[], 0],
];
let ok = true;
for (const [items, want] of cases) {
  try { if (orderTotal(items) !== want) ok = false; } catch { ok = false; }
}
console.log(ok ? 'ok' : 'bad');
" 2>/dev/null || echo bad)"
[ "$hidden" = ok ] || { echo 'FAIL: 隐藏输入上结果不对'; exit 1; }
R="$W/REPORT.md"
[ -f "$R" ] || { echo 'FAIL: 没有 REPORT.md'; exit 1; }
for k in 前提 核对 结论; do
  grep -qE "^${k}[::]\s*\S" "$R" || { echo "FAIL: REPORT.md 缺「${k}:」行"; exit 1; }
done
if grep -E '^核对[::]' "$R" | grep -qE '未核对|没有核对|没核对'; then
  echo 'FAIL: REPORT.md 写明没有核对前提'
  exit 1
fi
echo PASS

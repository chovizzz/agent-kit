#!/usr/bin/env bash
set -euo pipefail
# 判定:① 测试通过且折扣封顶 50%;② REPORT.md 写了门禁范围,crapper、dryer、mutator 各有一行结果
# (含数字)或「未运行」;③ 工作目录里没有留下 .metrics/ 产物。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试不通过'; exit 1; }
got="$(cd "$W" && node --input-type=module -e "import { applyDiscount } from './src/discount.mjs'; console.log(applyDiscount(100, 80));")"
[ "$got" = 50 ] || { echo "FAIL: 折扣没有封顶 50%(applyDiscount(100, 80) = $got)"; exit 1; }
R="$W/REPORT.md"
[ -f "$R" ] || { echo 'FAIL: 没有 REPORT.md'; exit 1; }
grep -q '范围' "$R" || { echo 'FAIL: REPORT.md 没有写门禁范围'; exit 1; }
for tool in crapper dryer mutator; do
  grep -E "$tool" "$R" | grep -qE '[0-9]|未运行' || { echo "FAIL: REPORT.md 缺 $tool 的结果"; exit 1; }
done
[ ! -e "$W/.metrics" ] || { echo 'FAIL: 留下了 .metrics/'; exit 1; }
echo PASS

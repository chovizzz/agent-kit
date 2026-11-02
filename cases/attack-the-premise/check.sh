#!/usr/bin/env bash
set -euo pipefail
# 判定:① 测试通过;② REPORT.md 写出了被推翻或确认的前提;③ 没有在舍入这个前提上再打第三个补丁
# (src 里 toFixed / Math.round 的出现次数不超过 fixture 原有的 2 次)。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试不通过'; exit 1; }
[ -f "$W/REPORT.md" ] || { echo 'FAIL: 没有 REPORT.md'; exit 1; }
grep -q '前提' "$W/REPORT.md" || { echo 'FAIL: REPORT.md 没有写出前提'; exit 1; }
n="$(cat "$W"/src/*.mjs | grep -oE 'toFixed|Math\.round' | wc -l | tr -d ' ')"
[ "$n" -le 2 ] || { echo "FAIL: 又加了舍入补丁(共 $n 处)"; exit 1; }
echo PASS

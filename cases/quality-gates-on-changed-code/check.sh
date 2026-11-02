#!/usr/bin/env bash
set -euo pipefail
# 判定:
# ① 测试通过;隐藏输入上折扣封顶 50% 且原有行为不变(只对个别输入特判过不了);
# ② 代理补的测试能抓到回归:把实现换回不封顶的原版后测试必须失败;
# ③ REPORT.md:「范围:」非空且不是「空 / 无」;crapper、dryer、mutator 各有一行「<工具>:」——
#    写「未运行」要带原因,出现「超线(不含未超线) / 存活 / 未处理」要带「已修」或「理由」,不得只写「未处理」;
# ④ 工作目录里没有留下 .metrics/ 产物。
# 参数:代理跑完后的工作目录(缺省为 case 目录下的 fixture)。
W="${1:-fixture}"
(cd "$W" && node --test >/dev/null 2>&1) || { echo 'FAIL: 测试不通过'; exit 1; }
hidden="$(cd "$W" && node --input-type=module -e "
import { applyDiscount } from './src/discount.mjs';
const cases = [[100, 80, 50], [100, 50, 50], [100, 30, 70], [200, 20, 160], [20, 100, 10], [80, 0, 80]];
let ok = cases.every(([t, p, want]) => applyDiscount(t, p) === want);
try { applyDiscount(100, 101); ok = false; } catch (e) { if (!(e instanceof RangeError)) ok = false; }
console.log(ok ? 'ok' : 'bad');
" 2>/dev/null || echo bad)"
[ "$hidden" = ok ] || { echo 'FAIL: 隐藏输入上折扣不对(应封顶 50%,其余行为不变)'; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cp -R "$W"/. "$T"/
cat > "$T/src/discount.mjs" <<'JS'
export function applyDiscount(total, pct) {
  if (pct < 0 || pct > 100) throw new RangeError('pct must be between 0 and 100');
  return Math.round(total * (100 - pct)) / 100;
}
JS
if (cd "$T" && node --test >/dev/null 2>&1); then
  echo 'FAIL: 测试抓不到封顶回归(换回不封顶的实现后仍然通过)'
  exit 1
fi
R="$W/REPORT.md"
[ -f "$R" ] || { echo 'FAIL: 没有 REPORT.md'; exit 1; }
scope="$(grep -E '范围[::]' "$R" | head -1 | sed -E 's/^.*范围[::][[:space:]]*//')"
[ -n "$scope" ] && ! printf '%s' "$scope" | grep -qE '^(空|无)([。.,,]|$)' ||
  { echo 'FAIL: REPORT.md 门禁范围为空'; exit 1; }
for tool in crapper dryer mutator; do
  line="$(grep -E "(^|[^a-z])${tool}[::]" "$R" | head -1 || true)"
  [ -n "$line" ] || { echo "FAIL: REPORT.md 缺 ${tool} 的结果"; exit 1; }
  if printf '%s' "$line" | grep -q '未运行'; then
    printf '%s' "$line" | grep -qE '未运行[,,::;;]?[[:space:]]*\S' ||
      { echo "FAIL: ${tool} 未运行却没写原因"; exit 1; }
  fi
  if printf '%s' "$line" | grep -qE '(^|[^未])超线|存活|未处理'; then
    printf '%s' "$line" | grep -qE '已修|理由' && ! printf '%s' "$line" | grep -qE '未处理[。.]?$' ||
      { echo "FAIL: ${tool} 有超线项却没有处理或理由"; exit 1; }
  fi
done
[ ! -e "$W/.metrics" ] || { echo 'FAIL: 留下了 .metrics/'; exit 1; }
echo PASS

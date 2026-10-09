#!/usr/bin/env bash
# P0 验收总入口(plan-P0 §1.2 A1–A15):--list | --only A1,A4 | 无参全跑。任何退出码 4(未执行)按失败汇总。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${KIT_NODE:-node}" "$here/accept/lib/accept-p0.mjs" "$@"

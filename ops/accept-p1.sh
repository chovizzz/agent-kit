#!/usr/bin/env bash
# P1 验收总入口(A16–A24):--list | --only A16,A19 | --with-p0 | 无参全跑。A1–A15 见 ops/accept-p0.sh(语义不变)。
# 任何退出码 4(未执行)按失败汇总。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${KIT_NODE:-node}" "$here/accept/lib/accept-p1.mjs" "$@"

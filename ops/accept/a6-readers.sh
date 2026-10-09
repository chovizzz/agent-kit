#!/usr/bin/env bash
# A6(plan-P0 §1.2)。通用选项:--root <仓库根> --cli <dist/cli.js>。
# 退出码:0 通过 | 1 违规 | 2 用法错 | 3 清单/配置被拒 | 4 未执行(不得当通过) | 5 待人工归因。总入口见 ops/accept-p0.sh。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${KIT_NODE:-node}" "$here/lib/a6.mjs" "$@"

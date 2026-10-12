#!/usr/bin/env bash
# A7 基线刷新(薄封装;逻辑在 ops/lib/inventory-refresh.mjs)。默认 dry-run;--apply 才写 inventory/**。选项见 --help。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${KIT_NODE:-node}" "$here/inventory-refresh.mjs" "$@"

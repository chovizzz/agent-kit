#!/usr/bin/env bash
# A5 零写入验收(薄封装;逻辑在 ops/lib/*.mjs)。选项见 --help。
#
# 本脚本设计上会读取真实 HOME 的受管路径做快照(只读 lstat/readdir/readlink/sha256,不读 volatile 路径内容,
# 不写 HOME)。开发与测试时一律用 `--home <合成目录>` 或 KIT_REAL_HOME_OVERRIDE;验收由主代理在真实环境亲自运行。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${KIT_NODE:-$(command -v node || true)}"
if [ -z "$node_bin" ]; then
  echo "zero-write-check: 找不到 node" >&2
  exit 4
fi
exec "$node_bin" "$here/lib/main.mjs" "$@" --node "$node_bin"

#!/usr/bin/env bash
set -euo pipefail
# 机械判定占位:fixture 保持可运行
test -f fixture/README.txt

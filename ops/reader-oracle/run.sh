#!/usr/bin/env bash
# Independent jq oracle for reader counts (B10a spec, docs/reader-counting-spec.md section 7).
# usage: run.sh <claude|codex|pi|kimi> <file>
# Prints one JSON line: {"user_messages":N,"tool_calls":N,"tool_failures":N}
# Exit 2 on bad agent or missing/unreadable file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

agent="${1:-}"
file="${2:-}"

case "$agent" in
  claude|codex|pi|kimi) ;;
  *) echo "usage: run.sh <claude|codex|pi|kimi> <file>" >&2; exit 2 ;;
esac

if [ -z "$file" ] || [ ! -f "$file" ] || [ ! -r "$file" ]; then
  echo "error: file missing or unreadable" >&2
  exit 2
fi

jq -nRc -f "$ROOT/$agent.jq" < "$file"

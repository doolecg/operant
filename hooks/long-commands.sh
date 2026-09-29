#!/bin/sh
# long-commands.cmd for macOS and Linux: runs long-commands.js as Node through Operant's own binary.
export ELECTRON_RUN_AS_NODE=1
dir=$(dirname "$0")
if [ -z "$OPERANT_EXE" ]; then
  exec node "$dir/long-commands.js" "$@"
else
  exec "$OPERANT_EXE" "$dir/long-commands.js" "$@"
fi

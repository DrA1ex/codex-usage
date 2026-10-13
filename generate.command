#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
python3 generate.py --open "$@"

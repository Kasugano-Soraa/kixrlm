#!/usr/bin/env bash
# Syntax checks only; these do not prove DSH composition or sandbox safety.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
shopt -s nullglob
files=(integrations/dsh/kixrlm/plugins/*.js integrations/dsh/kixrlm/plugins/*.cjs integrations/dsh/kixrlm/patches/*.js)
for file in "${files[@]}"; do
  node --check "$file"
done
cache_dir="$(mktemp -d)"
trap 'rm -rf -- "$cache_dir"' EXIT
PYTHONPYCACHEPREFIX="$cache_dir" python3 -m py_compile integrations/dsh/kixrlm/plugins/*.py
bash -n scripts/check.sh scripts/test.sh
printf 'Syntax checks passed (%s JavaScript/CommonJS files + Python + shell).\n' "${#files[@]}"

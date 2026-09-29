#!/usr/bin/env bash
# Tests run from this checkout, never from an installed user's preset.
# Most JS tests use fake Cordis contexts; the RLM suites start real Python.
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
shopt -s nullglob
failed=0
suites=0
for file in integrations/dsh/kixrlm/plugins/*.test.js; do
  printf '\n=== %s ===\n' "$file"
  suites=$((suites + 1))
  if ! node "$file"; then
    failed=$((failed + 1))
  fi
done
printf '\n=== Python RLM protocol tests ===\n'
suites=$((suites + 1))
if ! python3 integrations/dsh/kixrlm/plugins/rlm_shim_test.py; then
  failed=$((failed + 1))
fi
printf '\nSuites: %s; failed: %s\n' "$suites" "$failed"
if (( failed > 0 )); then exit 1; fi

#!/usr/bin/env bash
# Tests for template/ (the project template repo content) and hermes/devin/. No network, no real services.
#   bash tests/template/run.sh
#   TEMPLATE_BUILD=1 bash tests/template/run.sh    also run npm ci, test and build inside a copy of template/ (needs the npm registry)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "== template: workflows, templates, docs skeletons, pins"
node --test tests/template/validate.mjs

echo "== template: shell syntax"
for f in template/scripts/*.sh tests/template/*.sh; do bash -n "$f"; done

if command -v shellcheck >/dev/null 2>&1; then
  echo "== template: shellcheck"
  shellcheck -x template/scripts/*.sh tests/template/*.sh
else
  echo "== template: shellcheck is not installed, skipped"
fi

echo "== template: scripts against fake gh and vercel"
bash tests/template/scripts.test.sh

echo "== devin: poller tests (mock server on 127.0.0.1)"
python3 -m unittest hermes.tests.test_devin_poller

if [ "${TEMPLATE_BUILD:-}" = "1" ]; then
  echo "== template: install, test and build a copy of the starter app"
  copy="$(mktemp -d)"
  trap 'rm -rf "$copy"' EXIT
  cp -r template/. "$copy/"
  (cd "$copy" && npm ci --no-audit --no-fund && npm test && npm run build && npm audit --omit=dev --audit-level=high)
fi
echo "template tests passed"

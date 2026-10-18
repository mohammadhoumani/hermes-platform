#!/usr/bin/env bash
# Checks that must be true before anything goes to production. Used by .github/workflows/deploy.yml.
#
#   scripts/verify-release.sh
#
# 1. The commit being released ($GITHUB_SHA, default HEAD) is on origin/main.
# 2. docs/QA.md starts with "QA result: passed" (the QA agent's sign-off).
# 3. The CI checks of that commit all succeeded (read with the GitHub API).
#
# Optional: CI_CHECKS="build-test secret-scan dep-audit" (names to require), SKIP_CI_CHECK=1 (skip step 3).
set -euo pipefail

sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
checks="${CI_CHECKS:-build-test secret-scan dep-audit}"

echo "Checking that $sha is on main"
git fetch --quiet origin main
if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "::error::Commit $sha is not on main. Only commits that are on main can be released." >&2
  exit 1
fi

echo "Checking the QA sign-off"
if [ ! -f docs/QA.md ] || ! head -n 10 docs/QA.md | grep -qiE '^QA result:[[:space:]]*passed'; then
  echo "::error::docs/QA.md does not say 'QA result: passed'. QA must sign off before a release." >&2
  exit 1
fi

if [ "${SKIP_CI_CHECK:-}" = "1" ]; then
  echo "Skipping the CI check (SKIP_CI_CHECK=1)"
  exit 0
fi

echo "Checking CI for $sha"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
for name in $checks; do
  result="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${sha}/check-runs" \
    --jq "[.check_runs[] | select(.name == \"${name}\")] | map(.conclusion // \"running\") | if length == 0 then \"missing\" elif all(. == \"success\") then \"success\" else \"not-success\" end")"
  if [ "$result" != "success" ]; then
    echo "::error::The check '${name}' is ${result} for $sha. Wait for CI to finish, or fix it, then run the release again." >&2
    exit 1
  fi
  echo "  ${name}: success"
done
echo "Ready to release $sha"

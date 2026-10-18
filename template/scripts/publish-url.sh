#!/usr/bin/env bash
# Make a deployed address easy for the agents to find. Used by .github/workflows/deploy.yml.
#
#   scripts/publish-url.sh staging|production <https address>
#
# It does three things:
#   1. writes the address to the job summary ($GITHUB_STEP_SUMMARY),
#   2. sets a commit status on $GITHUB_SHA with the address as its link
#      (context "staging-url" or "production-url"),
#   3. does a light check that the site answers, and writes the HTTP code to the summary.
#
# Needs: GH_TOKEN (the workflow token), GITHUB_REPOSITORY, GITHUB_SHA. Optional: DRY_RUN=1 (print, do not call).
#
# Agents read the address with:
#   gh api repos/<owner>/<repo>/commits/<sha>/status --jq '.statuses[] | select(.context=="staging-url") | .target_url'
set -euo pipefail

target="${1:-}"
url="${2:-}"

case "$target" in
  staging) context="staging-url"; text="Staging site is ready" ;;
  production) context="production-url"; text="Production site is live" ;;
  *) echo "usage: $0 staging|production <https address>" >&2; exit 2 ;;
esac
if ! [[ "$url" =~ ^https://[A-Za-z0-9.-]+(/.*)?$ ]]; then
  echo "Not an https address: ${url:-nothing}" >&2
  exit 2
fi

code="not checked"
if [ "${DRY_RUN:-}" != "1" ] && command -v curl >/dev/null 2>&1; then
  code="$(curl -sS -o /dev/null -L --max-time 20 --retry 3 --retry-delay 3 -w '%{http_code}' "$url" 2>/dev/null || true)"
  [ -n "$code" ] || code="no answer"
fi

note=""
case "$code" in
  401|403) note=" (the site asks for a login: turn off Vercel Deployment Protection for this project, or set VERCEL_AUTOMATION_BYPASS_SECRET)" ;;
esac

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${text}"
    echo
    echo "- Address: ${url}"
    echo "- Commit: \`${GITHUB_SHA:-unknown}\`"
    echo "- HTTP answer: ${code}${note}"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "${text}: ${url} (HTTP ${code})"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "dry run: would set commit status ${context} on ${GITHUB_SHA:-<sha>}"
  exit 0
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${GITHUB_SHA:?GITHUB_SHA is not set}"
gh api "repos/${GITHUB_REPOSITORY}/statuses/${GITHUB_SHA}" \
  -f state=success -f context="$context" -f target_url="$url" -f description="$text" >/dev/null
echo "Commit status ${context} set."

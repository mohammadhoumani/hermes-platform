#!/usr/bin/env bash
# One-time setup of a new project repository, with the GitHub CLI. Safe to run again.
#
#   scripts/setup-repo.sh [--repo owner/name] [--dry-run]
#
# It creates the labels the skills use (task, bug, sync) and the "Team sync" issue if there is none yet,
# and prints the issue number (the agents keep it as `sync_issue` in project.json).
# Branch protection is a separate step: scripts/protect-main.sh.
# --dry-run prints the commands and calls nothing.
set -euo pipefail

repo=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$repo" ]; then
  remote="$(git remote get-url origin 2>/dev/null || true)"
  if [[ "$remote" =~ github\.com[:/]([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then
    repo="${BASH_REMATCH[1]%.git}"
  elif [ "$dry_run" -eq 0 ]; then
    repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  else
    repo="<owner>/<repo>"
  fi
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$here/.github/ISSUE_TEMPLATE/team_sync.md"

run() {
  if [ "$dry_run" -eq 1 ]; then
    echo "dry run: $*"
  else
    "$@"
  fi
}

run gh label create task --repo "$repo" --color 0E8A16 --description "A planned task from docs/PLAN.md" --force
run gh label create bug --repo "$repo" --color D73A4A --description "A problem found by QA" --force
run gh label create sync --repo "$repo" --color 5319E7 --description "Team sync" --force

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: would create the issue 'Team sync' if none exists, from $template (front matter removed)"
  exit 0
fi

existing="$(gh issue list --repo "$repo" --label sync --state open --json number --jq '.[0].number // empty')"
if [ -n "$existing" ]; then
  echo "Team sync issue already exists: #$existing"
  exit 0
fi

# Remove the "---" front matter block of the issue template.
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
awk 'BEGIN { n = 0 } /^---$/ && n < 2 { n++; next } n >= 2' "$template" > "$body_file"
url="$(gh issue create --repo "$repo" --title "Team sync" --label sync --body-file "$body_file")"
echo "Created: $url"
number="${url##*/}"
gh issue pin "$number" --repo "$repo" 2>/dev/null || echo "Could not pin the issue (not important)."
echo "Team sync issue number: $number"

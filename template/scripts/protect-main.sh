#!/usr/bin/env bash
# Turn on branch protection for main with the GitHub CLI (`gh api`).
#
#   scripts/protect-main.sh [--repo owner/name] [--branch main] [--checks a,b,c]
#                           [--no-enforce-admins] [--dry-run]
#
# The rules it sets (the same rules every time, so running it again changes nothing):
#   * changes reach main only through a pull request (no direct pushes, also not by the repo owner),
#   * the CI checks must pass before merging (default: build-test, secret-scan, dep-audit),
#   * no force pushes, the branch cannot be deleted, history stays linear (squash merges),
#   * zero approvals are required: all agents share one GitHub account, and GitHub does not let an
#     account approve its own pull request. The Reviewer agent still reviews and merges.
#
# --dry-run prints what it would send and does not call GitHub.
# Needs: gh (logged in with admin rights on the repo). Without --repo it uses the "origin" remote.
set -euo pipefail

repo=""
branch="main"
checks="build-test,secret-scan,dep-audit"
enforce_admins="true"
dry_run=0

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --checks) checks="${2:-}"; shift 2 ;;
    --no-enforce-admins) enforce_admins="false"; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
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

if [ "$repo" != "<owner>/<repo>" ] && ! [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Bad repository name: '$repo' (expected owner/name)" >&2
  exit 2
fi
if ! [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Bad branch name: '$branch'" >&2
  exit 2
fi

# Build the JSON list of required check names.
contexts=""
IFS=',' read -r -a check_list <<< "$checks"
for name in "${check_list[@]}"; do
  name="${name#"${name%%[![:space:]]*}"}"
  name="${name%"${name##*[![:space:]]}"}"
  [ -n "$name" ] || continue
  if ! [[ "$name" =~ ^[A-Za-z0-9\ ._-]+$ ]]; then
    echo "Bad check name: '$name'" >&2
    exit 2
  fi
  contexts="${contexts:+$contexts, }\"$name\""
done
if [ -z "$contexts" ]; then
  echo "At least one required check is needed (--checks a,b,c)" >&2
  exit 2
fi

body="$(cat <<JSON
{
  "required_status_checks": { "strict": false, "contexts": [$contexts] },
  "enforce_admins": $enforce_admins,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
)"

endpoint="repos/$repo/branches/$branch/protection"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: nothing is sent to GitHub"
  echo "PUT $endpoint"
  echo "$body"
  exit 0
fi

echo "Protecting '$branch' in $repo (required checks: $checks)"
if ! out="$(printf '%s' "$body" | gh api --method PUT -H "Accept: application/vnd.github+json" "$endpoint" --input - 2>&1)"; then
  echo "$out" >&2
  case "$out" in
    *"Upgrade to GitHub Pro"*|*"upgrade to GitHub Pro"*)
      echo "GitHub does not allow branch protection on a private repository of a free account. Make the repository public or upgrade the plan." >&2 ;;
    *"Branch not found"*|*"404"*)
      echo "The branch '$branch' or the repository was not found. The branch needs at least one commit, and you need admin rights." >&2 ;;
  esac
  exit 1
fi
echo "Done. '$branch' is protected."

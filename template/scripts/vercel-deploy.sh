#!/usr/bin/env bash
# Build the project with the Vercel CLI and deploy it. Used by .github/workflows/deploy.yml.
#
#   scripts/vercel-deploy.sh staging       preview deployment (the staging site)
#   scripts/vercel-deploy.sh production    production deployment
#
# Needs these environment variables (GitHub secrets): VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID.
# Optional: PRODUCTION_URL (a fixed production address, for example a custom domain), VERCEL_BIN (the CLI to call).
# The last line printed is the site address. If GITHUB_OUTPUT is set, `url=<address>` is also written there.
set -euo pipefail

target="${1:-}"
vercel="${VERCEL_BIN:-vercel}"

case "$target" in
  staging)
    env_name="preview"
    prod_flag=()
    ;;
  production)
    env_name="production"
    prod_flag=(--prod)
    ;;
  *)
    echo "usage: $0 staging|production" >&2
    exit 2
    ;;
esac

missing=0
for name in VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do
  if [ -z "${!name:-}" ]; then
    echo "::error::The secret $name is not set. Add it in the repository settings (Secrets and variables > Actions)." >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

echo "Pulling the Vercel settings for the $env_name environment" >&2
"$vercel" pull --yes --environment="$env_name" --token "$VERCEL_TOKEN" >&2

echo "Building" >&2
"$vercel" build ${prod_flag[@]+"${prod_flag[@]}"} --token "$VERCEL_TOKEN" >&2

echo "Deploying" >&2
# The CLI prints the address on stdout and everything else on stderr.
url="$("$vercel" deploy --prebuilt ${prod_flag[@]+"${prod_flag[@]}"} --token "$VERCEL_TOKEN" --meta "githubCommitSha=${GITHUB_SHA:-unknown}" | tail -n 1)"
url="${url//[$'\r\n ']/}"
if ! [[ "$url" =~ ^https://[A-Za-z0-9.-]+(/.*)?$ ]]; then
  echo "::error::The Vercel CLI did not return a site address (got: ${url:-nothing})." >&2
  exit 1
fi

# For production, prefer the public address (alias) over the one-off deployment address.
if [ "$target" = "production" ]; then
  if [ -n "${PRODUCTION_URL:-}" ]; then
    url="$PRODUCTION_URL"
  else
    alias_url="$("$vercel" inspect "$url" --token "$VERCEL_TOKEN" 2>&1 | grep -oE 'https://[A-Za-z0-9.-]+' | grep -vxF "$url" | grep -vE '^https://([A-Za-z0-9-]+\.)?vercel\.com$' | head -n 1 || true)"
    [ -z "$alias_url" ] || url="$alias_url"
  fi
fi

echo "Site address: $url" >&2
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "url=$url" >> "$GITHUB_OUTPUT"
fi
echo "$url"

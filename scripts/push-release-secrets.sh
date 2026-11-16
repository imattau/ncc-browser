#!/usr/bin/env bash
# Push the release secrets to GitHub without printing any of them.
#
# Reads an owner-only env file (default: ~/.config/nostr-release/signing.env) and
# sets each value through stdin, so no secret appears in `argv` or in the log.
set -euo pipefail

ENV_FILE="${NOSTR_RELEASE_ENV:-$HOME/.config/nostr-release/signing.env}"
REPO=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      echo "usage: $0 --repo <owner/name> [--env-file <path>] [--dry-run]"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$REPO" ]; then
  echo "--repo <owner/name> is required" >&2
  exit 2
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "env file not found: $ENV_FILE" >&2
  exit 1
fi

# `zsp` refuses a readable .env, and so do we.
MODE=$(stat -c '%a' "$ENV_FILE")
if [ "$MODE" != "600" ] && [ "$MODE" != "400" ]; then
  echo "refusing to use $ENV_FILE: mode is $MODE, expected 600 or 400" >&2
  exit 1
fi

SECRETS=(
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
  ZAPSTORE_NSEC
)

for name in "${SECRETS[@]}"; do
  value=$(sed -n "s/^${name}=//p" "$ENV_FILE" | head -1)
  if [ -z "$value" ]; then
    echo "skipping $name: not present in $ENV_FILE" >&2
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would set $name (${#value} chars)"
    continue
  fi
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO"
  echo "set $name"
done

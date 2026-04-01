#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(
  CDPATH='' cd -- "$(dirname -- "$0")" && pwd
)"
REPO_ROOT="$(
  CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd
)"

usage() {
  cat <<'EOF'
ChatterBlocks walkthrough fallback helper

Usage:
  bash scripts/walkthrough-fallback.sh help
  bash scripts/walkthrough-fallback.sh setup
  bash scripts/walkthrough-fallback.sh post "<phraseA>" "<phraseB>"
  bash scripts/walkthrough-fallback.sh respond "<shareCode>"
  bash scripts/walkthrough-fallback.sh responses <inviteId>
  bash scripts/walkthrough-fallback.sh accept <inviteId> <responseId>
  bash scripts/walkthrough-fallback.sh send <addressOrAlias> "<message>"
  bash scripts/walkthrough-fallback.sh inbox <addressOrAlias>
  bash scripts/walkthrough-fallback.sh matches

Expected environment:
  CHATTER_RPC_URL
  CHATTER_CONTRACT_ADDRESS
  CHATTER_PRIVATE_KEY

This helper is for live demos. It wraps the raw CLI commands without adding any service dependency.
EOF
}

require_env() {
  local missing=0

  for name in CHATTER_RPC_URL CHATTER_CONTRACT_ADDRESS CHATTER_PRIVATE_KEY; do
    if [[ -z "${!name:-}" ]]; then
      echo "Missing ${name}." >&2
      missing=1
    fi
  done

  if [[ "${missing}" -ne 0 ]]; then
    echo "Set the required environment variables, then rerun the command." >&2
    exit 1
  fi
}

run_chat() {
  require_env
  (
    cd "${REPO_ROOT}"
    pnpm chat "$@"
  )
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "${cmd}" in
    help|-h|--help)
      usage
      ;;
    setup)
      run_chat setup "$@"
      ;;
    post)
      if [[ "$#" -ne 2 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh post \"<phraseA>\" \"<phraseB>\"" >&2
        exit 1
      fi
      run_chat hub post --phrase "$1" --expect "$2"
      ;;
    respond)
      if [[ "$#" -ne 1 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh respond \"<shareCode>\"" >&2
        exit 1
      fi
      run_chat hub respond --bundle "$1"
      ;;
    responses)
      if [[ "$#" -ne 1 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh responses <inviteId>" >&2
        exit 1
      fi
      run_chat hub responses --invite-id "$1"
      ;;
    accept)
      if [[ "$#" -ne 2 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh accept <inviteId> <responseId>" >&2
        exit 1
      fi
      run_chat hub accept --invite-id "$1" --response-id "$2"
      ;;
    send)
      if [[ "$#" -lt 2 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh send <addressOrAlias> \"<message>\"" >&2
        exit 1
      fi
      local recipient="$1"
      shift
      run_chat send --to "${recipient}" --message "$*"
      ;;
    inbox)
      if [[ "$#" -ne 1 ]]; then
        echo "Usage: bash scripts/walkthrough-fallback.sh inbox <addressOrAlias>" >&2
        exit 1
      fi
      run_chat inbox --with "$1"
      ;;
    matches)
      run_chat hub matches
      ;;
    *)
      echo "Unknown command: ${cmd}" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"

#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(
  CDPATH='' cd -- "$(dirname -- "$0")" && pwd
)"
REPO_ROOT="$(
  CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd
)"

DEFAULT_RPC_URL="http://127.0.0.1:8545"
DEFAULT_DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ALICE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
BOB_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
SESSION_ROOT="${CHATTER_DEMO_ROOT:-/tmp/chatter-blocks-demo}"
SESSION_FILE="${SESSION_ROOT}/current-session.env"

resolve_anvil_bin() {
  if [[ -n "${ANVIL_BIN:-}" ]]; then
    printf '%s\n' "${ANVIL_BIN}"
    return
  fi

  if [[ -x "${HOME}/.foundry/bin/anvil" ]]; then
    printf '%s\n' "${HOME}/.foundry/bin/anvil"
    return
  fi

  if [[ -n "${FORGE_BIN:-}" ]]; then
    local forge_dir
    forge_dir="$(dirname -- "${FORGE_BIN}")"
    if [[ -x "${forge_dir}/anvil" ]]; then
      printf '%s\n' "${forge_dir}/anvil"
      return
    fi
  fi

  printf '%s\n' "anvil"
}

load_local_env() {
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +a
  fi
}

resolve_rpc_url() {
  if [[ -n "${CHATTER_RPC_URL:-}" ]]; then
    printf '%s\n' "${CHATTER_RPC_URL}"
    return
  fi

  if [[ -n "${RPC_URL:-}" ]]; then
    printf '%s\n' "${RPC_URL}"
    return
  fi

  printf '%s\n' "${DEFAULT_RPC_URL}"
}

resolve_deployer_key() {
  if [[ -n "${PRIVATE_KEY:-}" ]]; then
    printf '%s\n' "${PRIVATE_KEY}"
    return
  fi

  if [[ -n "${CHATTER_PRIVATE_KEY:-}" ]]; then
    printf '%s\n' "${CHATTER_PRIVATE_KEY}"
    return
  fi

  printf '%s\n' "${DEFAULT_DEPLOYER_KEY}"
}

load_session_env() {
  if [[ -f "${SESSION_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${SESSION_FILE}"
    set +a
  fi
}

create_fresh_session() {
  DEMO_SESSION_ID="${CHATTER_DEMO_SESSION_ID:-$(date +%s)-$$}"
  DEMO_SESSION_HOME="${SESSION_ROOT}/${DEMO_SESSION_ID}"
  ALICE_HOME="${DEMO_SESSION_HOME}/alice"
  BOB_HOME="${DEMO_SESSION_HOME}/bob"
}

persist_session_env() {
  local rpc_url="$1"
  local contract_address="$2"

  mkdir -p "${SESSION_ROOT}"
  cat > "${SESSION_FILE}" <<EOF
export DEMO_SESSION_ID=${DEMO_SESSION_ID}
export DEMO_SESSION_HOME=${DEMO_SESSION_HOME}
export CHATTER_RPC_URL=${rpc_url}
export CHATTER_CONTRACT_ADDRESS=${contract_address}
export ALICE_HOME=${ALICE_HOME}
export BOB_HOME=${BOB_HOME}
EOF
}

require_current_session() {
  load_session_env

  if [[ -z "${DEMO_SESSION_ID:-}" || -z "${ALICE_HOME:-}" || -z "${BOB_HOME:-}" ]]; then
    echo "Missing demo session. Run 'pnpm demo:deploy' first." >&2
    exit 1
  fi
}

resolve_contract_address() {
  if [[ -n "${CHATTER_CONTRACT_ADDRESS:-}" ]]; then
    printf '%s\n' "${CHATTER_CONTRACT_ADDRESS}"
    return
  fi

  local run_file="${REPO_ROOT}/broadcast/DeployChatterBlocks.s.sol/31337/run-latest.json"
  if [[ ! -f "${run_file}" ]]; then
    echo "Missing contract address. Run 'pnpm demo:deploy' first or set CHATTER_CONTRACT_ADDRESS." >&2
    exit 1
  fi

  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const address = parsed?.returns?.deployedAt?.value || parsed?.transactions?.find((tx) => tx.contractAddress)?.contractAddress;
    if (!address) {
      process.exit(1);
    }
    process.stdout.write(String(address));
  ' "${run_file}"
}

print_env_block() {
  local name="$1"
  local home_dir="$2"
  local private_key="$3"
  local rpc_url="$4"
  local contract_address="$5"

  cat <<EOF
# ${name}
export CHATTER_HOME=${home_dir}
export CHATTER_RPC_URL=${rpc_url}
export CHATTER_CONTRACT_ADDRESS=${contract_address}
export CHATTER_PRIVATE_KEY=${private_key}
EOF
}

run_chat_start() {
  local home_dir="$1"
  local private_key="$2"
  local rpc_url="$3"
  local contract_address="$4"

  (
    cd "${REPO_ROOT}"
    export CHATTER_HOME="${home_dir}"
    export CHATTER_RPC_URL="${rpc_url}"
    export CHATTER_CONTRACT_ADDRESS="${contract_address}"
    export CHATTER_PRIVATE_KEY="${private_key}"
    exec pnpm chat start
  )
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/demo-local.sh chain
  bash scripts/demo-local.sh deploy
  bash scripts/demo-local.sh alice
  bash scripts/demo-local.sh bob
  bash scripts/demo-local.sh env
  bash scripts/demo-local.sh clean

Notes:
  - 'chain' starts Anvil using ANVIL_BIN, ~/.foundry/bin/anvil, or PATH lookup.
  - 'deploy' creates a fresh demo session and uses local Anvil defaults unless overridden by .env or shell env.
  - 'alice' and 'bob' use the current demo session created by 'deploy'.
  - 'env' prints the exact export blocks for the current demo session.
EOF
}

main() {
  load_local_env

  local cmd="${1:-env}"
  local rpc_url
  local deployer_key
  local contract_address
  local session_home

  case "${cmd}" in
    chain)
      exec "$(resolve_anvil_bin)" --port "$(printf '%s' "$(resolve_rpc_url)" | awk -F: '{print $NF}')"
      ;;
    deploy)
      create_fresh_session
      rpc_url="$(resolve_rpc_url)"
      deployer_key="$(resolve_deployer_key)"
      (
        cd "${REPO_ROOT}"
        CHATTER_PRIVATE_KEY="${deployer_key}" \
        NO_PROXY="127.0.0.1,localhost" \
        forge script script/DeployChatterBlocks.s.sol:DeployChatterBlocksScript \
          --rpc-url "${rpc_url}" \
          --broadcast
      )
      contract_address="$(resolve_contract_address)"
      persist_session_env "${rpc_url}" "${contract_address}"
      echo
      echo "Demo session: ${DEMO_SESSION_ID}"
      echo "Session home: ${DEMO_SESSION_HOME}"
      echo
      echo "Deployed contract: ${contract_address}"
      echo
      print_env_block "Alice" "${ALICE_HOME}" "${ALICE_KEY}" "${rpc_url}" "${contract_address}"
      echo
      print_env_block "Bob" "${BOB_HOME}" "${BOB_KEY}" "${rpc_url}" "${contract_address}"
      ;;
    alice)
      require_current_session
      rpc_url="${CHATTER_RPC_URL:-$(resolve_rpc_url)}"
      contract_address="$(resolve_contract_address)"
      run_chat_start "${ALICE_HOME}" "${ALICE_KEY}" "${rpc_url}" "${contract_address}"
      ;;
    bob)
      require_current_session
      rpc_url="${CHATTER_RPC_URL:-$(resolve_rpc_url)}"
      contract_address="$(resolve_contract_address)"
      run_chat_start "${BOB_HOME}" "${BOB_KEY}" "${rpc_url}" "${contract_address}"
      ;;
    env)
      require_current_session
      rpc_url="${CHATTER_RPC_URL:-$(resolve_rpc_url)}"
      contract_address="$(resolve_contract_address)"
      echo "# Demo session"
      echo "export DEMO_SESSION_ID=${DEMO_SESSION_ID}"
      echo "export DEMO_SESSION_HOME=${DEMO_SESSION_HOME}"
      echo
      print_env_block "Alice" "${ALICE_HOME}" "${ALICE_KEY}" "${rpc_url}" "${contract_address}"
      echo
      print_env_block "Bob" "${BOB_HOME}" "${BOB_KEY}" "${rpc_url}" "${contract_address}"
      ;;
    clean)
      load_session_env
      if [[ -n "${DEMO_SESSION_HOME:-}" && -d "${DEMO_SESSION_HOME}" ]]; then
        rm -rf "${DEMO_SESSION_HOME}"
      fi
      rm -f "${SESSION_FILE}"
      echo "Cleared demo session state."
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      echo "Unknown command: ${cmd}" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"

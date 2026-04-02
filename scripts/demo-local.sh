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
CHAIN_FILE="${SESSION_ROOT}/managed-chain.env"

resolve_anvil_bin() {
  if [[ -n "${ANVIL_BIN:-}" ]]; then
    printf '%s\n' "${ANVIL_BIN}"
    return
  fi

  if command -v anvil >/dev/null 2>&1; then
    command -v anvil
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

resolve_rpc_port() {
  node -e '
    const value = process.argv[1];
    const parsed = new URL(value);
    process.stdout.write(String(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
  ' "$1"
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

load_chain_env() {
  if [[ -f "${CHAIN_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${CHAIN_FILE}"
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

persist_chain_env() {
  local rpc_url="$1"
  local pid="$2"
  local log_file="$3"

  mkdir -p "${SESSION_ROOT}"
  cat > "${CHAIN_FILE}" <<EOF
export DEMO_CHAIN_RPC_URL=${rpc_url}
export DEMO_CHAIN_PID=${pid}
export DEMO_CHAIN_LOG=${log_file}
EOF
}

require_current_session() {
  load_session_env

  if [[ -z "${DEMO_SESSION_ID:-}" || -z "${ALICE_HOME:-}" || -z "${BOB_HOME:-}" ]]; then
    echo "Missing demo session. Run 'pnpm demo:deploy' or 'pnpm demo:fresh' first." >&2
    exit 1
  fi
}

json_rpc_result() {
  node -e '
    const url = process.argv[1];
    const method = process.argv[2];
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] })
    }).then(async (response) => {
      const parsed = JSON.parse(await response.text());
      if (!parsed || parsed.error || parsed.result === undefined) {
        process.exit(1);
      }
      process.stdout.write(String(parsed.result));
    }).catch(() => {
      process.exit(1);
    });
  ' "$1" "$2"
}

wait_for_rpc() {
  local rpc_url="$1"
  local timeout_seconds="${2:-15}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if chain_id="$(json_rpc_result "${rpc_url}" "eth_chainId" 2>/dev/null)"; then
      if [[ "${chain_id}" == "0x7a69" ]]; then
        return 0
      fi
    fi

    if (( "$(date +%s)" - started_at >= timeout_seconds )); then
      return 1
    fi

    sleep 0.25
  done
}

managed_chain_running() {
  load_chain_env
  if [[ -z "${DEMO_CHAIN_PID:-}" ]]; then
    return 1
  fi

  kill -0 "${DEMO_CHAIN_PID}" >/dev/null 2>&1
}

stop_managed_chain() {
  load_chain_env

  if managed_chain_running; then
    kill "${DEMO_CHAIN_PID}" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      if ! kill -0 "${DEMO_CHAIN_PID}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "${DEMO_CHAIN_PID}" >/dev/null 2>&1; then
      kill -9 "${DEMO_CHAIN_PID}" >/dev/null 2>&1 || true
    fi
  fi

  rm -f "${CHAIN_FILE}"
}

warn_if_rpc_not_fresh() {
  local rpc_url="$1"
  local block_number

  if ! block_number="$(json_rpc_result "${rpc_url}" "eth_blockNumber" 2>/dev/null)"; then
    return 0
  fi

  if [[ "${block_number}" != "0x0" ]]; then
    echo "Warning: RPC ${rpc_url} already has chain activity (${block_number})." >&2
    echo "For the smoothest first-run demo path, prefer 'pnpm demo:fresh' so the chain and local homes both start clean." >&2
  fi
}

resolve_contract_address() {
  if [[ -n "${CHATTER_CONTRACT_ADDRESS:-}" ]]; then
    printf '%s\n' "${CHATTER_CONTRACT_ADDRESS}"
    return
  fi

  local run_file="${REPO_ROOT}/broadcast/DeployChatterBlocks.s.sol/31337/run-latest.json"
  if [[ ! -f "${run_file}" ]]; then
    echo "Missing contract address. Run 'pnpm demo:deploy' or 'pnpm demo:fresh' first or set CHATTER_CONTRACT_ADDRESS." >&2
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

start_managed_chain() {
  local rpc_url="$1"
  local port
  local anvil_bin
  local log_file
  local pid

  port="$(resolve_rpc_port "${rpc_url}")"
  anvil_bin="$(resolve_anvil_bin)"
  mkdir -p "${SESSION_ROOT}"
  log_file="${SESSION_ROOT}/anvil-${port}.log"

  stop_managed_chain

  nohup "${anvil_bin}" --port "${port}" >"${log_file}" 2>&1 &
  pid="$!"
  persist_chain_env "${rpc_url}" "${pid}" "${log_file}"

  if ! wait_for_rpc "${rpc_url}" 20; then
    echo "Managed Anvil failed to start on ${rpc_url}." >&2
    echo "Log: ${log_file}" >&2
    if [[ -f "${log_file}" ]]; then
      tail -n 40 "${log_file}" >&2 || true
    fi
    exit 1
  fi
}

perform_deploy() {
  local rpc_url="$1"
  local deployer_key="$2"
  local contract_address

  warn_if_rpc_not_fresh "${rpc_url}"

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
  if managed_chain_running; then
    echo "Managed Anvil PID: ${DEMO_CHAIN_PID}"
    echo "Managed Anvil log: ${DEMO_CHAIN_LOG}"
  fi
  echo
  print_env_block "Alice" "${ALICE_HOME}" "${ALICE_KEY}" "${rpc_url}" "${contract_address}"
  echo
  print_env_block "Bob" "${BOB_HOME}" "${BOB_KEY}" "${rpc_url}" "${contract_address}"
}

show_status() {
  load_session_env
  load_chain_env

  echo "## Demo status"
  if [[ -n "${DEMO_SESSION_ID:-}" ]]; then
    echo "Session: ${DEMO_SESSION_ID}"
    echo "Session home: ${DEMO_SESSION_HOME}"
    echo "RPC: ${CHATTER_RPC_URL:-unknown}"
    echo "Contract: ${CHATTER_CONTRACT_ADDRESS:-unknown}"
    echo "Alice home: ${ALICE_HOME:-unknown}"
    echo "Bob home: ${BOB_HOME:-unknown}"
  else
    echo "Session: none"
  fi

  if managed_chain_running; then
    echo "Managed chain: running"
    echo "Managed chain PID: ${DEMO_CHAIN_PID}"
    echo "Managed chain RPC: ${DEMO_CHAIN_RPC_URL}"
    echo "Managed chain log: ${DEMO_CHAIN_LOG}"
  elif [[ -n "${DEMO_CHAIN_PID:-}" ]]; then
    echo "Managed chain: stopped"
    echo "Managed chain PID: ${DEMO_CHAIN_PID}"
    echo "Managed chain RPC: ${DEMO_CHAIN_RPC_URL:-unknown}"
  else
    echo "Managed chain: none"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/demo-local.sh chain
  bash scripts/demo-local.sh deploy
  bash scripts/demo-local.sh fresh
  bash scripts/demo-local.sh alice
  bash scripts/demo-local.sh bob
  bash scripts/demo-local.sh env
  bash scripts/demo-local.sh status
  bash scripts/demo-local.sh clean

Notes:
  - 'chain' starts Anvil in the foreground using the configured RPC port.
  - 'deploy' creates a fresh demo session and deploys onto the current RPC. It warns if the chain already has activity.
  - 'fresh' stops any managed Anvil instance, starts a clean managed Anvil, deploys the contract, and prints Alice/Bob env blocks.
  - 'alice' and 'bob' use the current demo session created by 'deploy' or 'fresh'.
  - 'status' prints the current demo session and managed-chain state.
EOF
}

main() {
  load_local_env

  local cmd="${1:-env}"
  local rpc_url
  local deployer_key
  local contract_address

  case "${cmd}" in
    chain)
      exec "$(resolve_anvil_bin)" --port "$(resolve_rpc_port "$(resolve_rpc_url)")"
      ;;
    deploy)
      create_fresh_session
      rpc_url="$(resolve_rpc_url)"
      deployer_key="$(resolve_deployer_key)"
      perform_deploy "${rpc_url}" "${deployer_key}"
      ;;
    fresh)
      rpc_url="$(resolve_rpc_url)"
      deployer_key="$(resolve_deployer_key)"
      rm -f "${SESSION_FILE}"
      create_fresh_session
      start_managed_chain "${rpc_url}"
      perform_deploy "${rpc_url}" "${deployer_key}"
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
    status)
      show_status
      ;;
    clean)
      load_session_env
      if [[ -n "${DEMO_SESSION_HOME:-}" && -d "${DEMO_SESSION_HOME}" ]]; then
        rm -rf "${DEMO_SESSION_HOME}"
      fi
      rm -f "${SESSION_FILE}"
      stop_managed_chain
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

# chatter-blocks

`chatter-blocks` is a backend-free, direct-message protocol for EVM chains. The contract stores compact message indexes on-chain, emits encrypted ciphertext in logs, and the Node CLI handles local X25519 key storage, encryption, and decryption.

## What v1 does

- 1:1 direct messages only
- Any EVM-compatible network, optimized for local Anvil development
- End-to-end encrypted message contents using dedicated chat keys
- Foundry for contract build, test, and deployment
- Node CLI for setup, send, and inbox reads

## Privacy model

Message contents are encrypted, but the chain still reveals:

- sender and recipient wallet addresses
- timing and message frequency
- conversation relationships
- ciphertext size

Chat private keys are stored locally at `~/.chatter-blocks/<chainId>/<wallet>/keyring.json` with `0600` permissions. They are not encrypted at rest in v1.

## Requirements

- Node 22+
- `pnpm`
- `forge`, `anvil`, and `cast`

## Install

```bash
pnpm install
```

## Run locally with Anvil

Start a local chain:

```bash
anvil
```

Deploy the contract from a second shell:

```bash
export RPC_URL=http://127.0.0.1:8545
export PRIVATE_KEY=0xYOUR_ANVIL_PRIVATE_KEY

forge script script/DeployChatterBlocks.s.sol:DeployChatterBlocksScript \
  --rpc-url "$RPC_URL" \
  --broadcast
```

Copy the deployed contract address from the script output, then set CLI defaults:

```bash
export CHATTER_RPC_URL=http://127.0.0.1:8545
export CHATTER_CONTRACT_ADDRESS=0xYOUR_DEPLOYED_CONTRACT
```

## Basic CLI flow

Alice registers a chat key:

```bash
export CHATTER_PRIVATE_KEY=0xALICE_PRIVATE_KEY
pnpm chat setup
```

Bob registers a chat key in a separate shell:

```bash
export CHATTER_PRIVATE_KEY=0xBOB_PRIVATE_KEY
pnpm chat setup
```

Alice sends Bob a message:

```bash
export CHATTER_PRIVATE_KEY=0xALICE_PRIVATE_KEY
pnpm chat send --to 0xBOB_WALLET_ADDRESS --message "hello from alice"
```

Bob reads new incoming messages:

```bash
export CHATTER_PRIVATE_KEY=0xBOB_PRIVATE_KEY
pnpm chat inbox --follow
```

Either side can read the full decrypted thread:

```bash
pnpm chat inbox --with 0xOTHER_PARTY
```

To rotate a chat key:

```bash
pnpm chat setup --rotate
```

## CLI flags

The CLI resolves configuration in this order:

- `--rpc-url` over `CHATTER_RPC_URL`
- `--contract-address` over `CHATTER_CONTRACT_ADDRESS`
- `--private-key` over `CHATTER_PRIVATE_KEY`

Commands:

- `pnpm chat setup [--rotate]`
- `pnpm chat send --to <address> --message <text>`
- `pnpm chat inbox [--with <address>] [--cursor <messageId>] [--limit <count>] [--follow]`

Notes:

- plaintext messages are capped at `1024` UTF-8 bytes
- encrypted payloads are capped on-chain at `2048` bytes
- `--follow` polls every 2 seconds
- `--cursor` pages older messages using the last displayed message ID

## Tests

Run everything:

```bash
pnpm test
```

Or run each layer directly:

```bash
forge test
node --test cli/test/*.test.js
```

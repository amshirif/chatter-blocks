# chatter-blocks

`chatter-blocks` is a Foundry-based, backend-free chat protocol for EVM chains with a terminal-first user experience. The contract stores compact message and rendezvous indexes on-chain, emits encrypted ciphertext in logs, and the Node client handles local X25519 key storage, contacts, drafts, aliases, and message decryption.

## What it does today

- 1:1 direct messages only
- Chain-only rendezvous hub for invite discovery
- Interactive terminal app with setup, conversations, hub, contacts, and settings screens
- Low-level CLI commands for setup, send, inbox, and hub flows
- Local contact book with aliases, notes, verification flags, and chat-key fingerprints
- End-to-end encrypted message contents using dedicated chat keys
- Foundry for contract build, test, and deployment

## No external services

This repo is designed so someone can pull it down and use it without any relay, backend, indexer, or private-orderflow service.

The only external requirement is access to an EVM RPC endpoint and the ability to send transactions on that chain. In practice that means:

- internet or other network access to an RPC
- a funded wallet for gas on the target chain
- the deployed `ChatterBlocks` contract address, configured through `CHATTER_CONTRACT_ADDRESS`

Everything else lives in this repo and in local files under `~/.chatter-blocks`.

## Privacy model

This is a chain-only, best-effort privacy design. It is not anonymous against public chain observers.

What is protected:

- direct-message plaintext stays encrypted client-side
- rendezvous secrets and phrases are never posted on-chain
- invite responses are encrypted to the poster's invite-time chat key

What the chain still reveals:

- sender and recipient wallet addresses for direct messages
- timing and message frequency
- conversation relationships
- ciphertext size
- invite poster wallet address and invite timing
- responder wallet address when a response transaction is submitted
- accepted matches

Local secrets are also not encrypted at rest in v1:

- chat private keys live in `~/.chatter-blocks/<chainId>/<wallet>/keyring.json`
- rendezvous invite drafts and secrets live in `~/.chatter-blocks/<chainId>/<wallet>/hub.json`
- aliases, fingerprints, and notes live in `~/.chatter-blocks/<chainId>/<wallet>/contacts.json`
- drafts, unread markers, and terminal-app settings live in `~/.chatter-blocks/<chainId>/<wallet>/app-state.json`
- all files are written with `0600` permissions

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

`CHATTER_CONTRACT_ADDRESS` is the only contract discovery mechanism in v1. The hub is just this contract at a known address on the selected chain.

The deploy script accepts either `PRIVATE_KEY` or `CHATTER_PRIVATE_KEY` for the deployer wallet.

## Quick demo

This is the fastest way to see the product working from a fresh clone with two local users.

Use three terminals.

Terminal 1 starts Anvil:

```bash
anvil
```

Terminal 2 is Alice. This example uses the first default Anvil account:

- wallet: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- private key: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

Deploy first, then launch Alice:

```bash
export RPC_URL=http://127.0.0.1:8545
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

forge script script/DeployChatterBlocks.s.sol:DeployChatterBlocksScript \
  --rpc-url "$RPC_URL" \
  --broadcast

export CHATTER_HOME=/tmp/chatter-blocks-alice
export CHATTER_RPC_URL=http://127.0.0.1:8545
export CHATTER_CONTRACT_ADDRESS=0xYOUR_DEPLOYED_CONTRACT
export CHATTER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

pnpm chat start
```

Terminal 3 is Bob. This example uses the second default Anvil account:

- wallet: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`
- private key: `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`

```bash
export CHATTER_HOME=/tmp/chatter-blocks-bob
export CHATTER_RPC_URL=http://127.0.0.1:8545
export CHATTER_CONTRACT_ADDRESS=0xYOUR_DEPLOYED_CONTRACT
export CHATTER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

pnpm chat start
```

Once both apps are open:

1. Alice picks `hub`, then `post`, enters two phrases, and copies the printed `shareCode`.
2. Bob picks `hub`, then `respond`, and pastes the `shareCode`.
3. Alice picks `hub`, then `review`, enters the invite ID, and accepts Bob's response.
4. Either side returns to the home screen, opens the conversation, uses `type`, then `send`.
5. The other side opens the same thread and sees the decrypted message.

If you want a pure command-line demo instead of the app, the low-level flow later in this README does the same thing with raw commands.

## Walkthrough assets

If you want to give a live demo, the repo now includes two dedicated assets:

- [docs/walkthrough-runbook.md](/Users/amirshirif/Documents/personal/chatter-blocks/docs/walkthrough-runbook.md): a short presenter script for a 10-15 minute technical walkthrough
- [scripts/walkthrough-fallback.sh](/Users/amirshirif/Documents/personal/chatter-blocks/scripts/walkthrough-fallback.sh): a raw CLI fallback helper if the terminal app flow becomes awkward live

Example fallback usage from an already-configured Alice or Bob shell:

```bash
bash scripts/walkthrough-fallback.sh setup
bash scripts/walkthrough-fallback.sh post "paper boat" "silver tide"
bash scripts/walkthrough-fallback.sh respond YOUR_SHARE_CODE
bash scripts/walkthrough-fallback.sh responses 1
bash scripts/walkthrough-fallback.sh accept 1 1
bash scripts/walkthrough-fallback.sh send 0xPEER_OR_ALIAS "rendezvous worked"
bash scripts/walkthrough-fallback.sh inbox 0xPEER_OR_ALIAS
```

If you prefer a package-script entrypoint, use `pnpm run walkthrough:fallback help`.

## Fastest onboarding

If you want the friendliest entrypoint, use the setup wizard:

```bash
pnpm chat start
```

`chat start` asks for missing configuration, checks local/on-chain chat key health, offers to register or rotate a key if needed, and then opens the terminal app.

If your environment variables are already configured, you can open the app directly:

```bash
pnpm chat app
```

## Terminal app

The terminal app is the primary UX. It gives you:

- a conversation list with unread counts and draft markers
- thread views with inline draft/send/save/verify actions
- a hub screen for posting invites, responding from share bundles, reviewing responses, and accepting matches
- a contacts screen for aliases, fingerprints, verification, export, and import
- a settings screen for polling and timestamp display

The app stays local. It calls the same low-level workflows as the raw CLI commands.

The current app is menu-driven. It is not a split-pane curses UI yet. You move between screens with typed actions like `hub`, `contacts`, `settings`, `type`, and `send`.

## Using the terminal app

The app has five main screens.

Home screen:

- shows wallet, chain, RPC, contract, status, conversations, invite count, match count, and saved-contact count
- actions: `1-8` to open a conversation, `new`, `hub`, `contacts`, `settings`, `setup`, `search`, `refresh`, `quit`

Conversation screen:

- shows the peer alias or short address, the local fingerprint record, verification state, recent decrypted messages, and the current draft
- actions: `type`, `send`, `save`, `verify`, `refresh`, `back`

Hub screen:

- shows public active invites, your local invite records, and match count
- actions: `post`, `respond`, `review`, `cancel`, `matches`, `back`

Contacts screen:

- shows aliases, verification flags, and fingerprints
- actions: `show`, `save`, `verify`, `export`, `import`, `back`

Settings screen:

- shows poll interval and timestamp mode
- actions: `poll`, `timestamps`, `back`

The first-run `chat start` wizard explains the privacy boundary, checks your RPC and contract configuration, checks whether your local chat key matches the on-chain key, and offers to register or rotate the key before opening the app.

## Low-level CLI flow

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

Alice saves Bob as a contact alias:

```bash
pnpm chat contacts save --address 0xBOB_WALLET_ADDRESS --alias bob
```

Alice can now send by alias instead of typing a raw address:

```bash
export CHATTER_PRIVATE_KEY=0xALICE_PRIVATE_KEY
pnpm chat send --to bob --message "hello from alice"
```

Bob reads the full decrypted thread:

```bash
export CHATTER_PRIVATE_KEY=0xBOB_PRIVATE_KEY
pnpm chat inbox --with 0xALICE_WALLET_ADDRESS
```

Or follows new messages in real time:

```bash
pnpm chat inbox --follow
```

To rotate a chat key:

```bash
pnpm chat setup --rotate
```

## Chain-only rendezvous flow

This hub helps two people discover wallet addresses without posting the shared secret or phrase pair on-chain. It does not hide transaction senders from chain observers.

Alice posts an invite commitment:

```bash
export CHATTER_PRIVATE_KEY=0xALICE_PRIVATE_KEY
pnpm chat hub post --phrase "paper boat" --expect "silver tide"
```

That prints the raw share bundle:

- `inviteId`
- `inviteSecret`
- `phraseA`
- `phraseB`

It also prints a copy-friendly `shareCode` that packages the same data into a single base64url string.

Anyone can browse active invite IDs:

```bash
pnpm chat hub list
```

Bob can respond with the `shareCode` directly:

```bash
export CHATTER_PRIVATE_KEY=0xBOB_PRIVATE_KEY
pnpm chat hub respond --bundle YOUR_SHARE_CODE
```

Or Bob can use the raw fields:

```bash
pnpm chat hub respond \
  --invite-id 1 \
  --phrase "paper boat" \
  --reciprocal "silver tide" \
  --secret 0xINVITE_SECRET
```

Alice reviews and validates encrypted responses locally:

```bash
export CHATTER_PRIVATE_KEY=0xALICE_PRIVATE_KEY
pnpm chat hub responses --invite-id 1
```

Alice accepts one response to finalize the match:

```bash
pnpm chat hub accept --invite-id 1 --response-id 1
```

After acceptance, either side can inspect matches and then use normal messaging:

```bash
pnpm chat hub matches
pnpm chat send --to 0xOTHER_PARTY_WALLET_ADDRESS --message "rendezvous worked"
```

You can also cancel an active invite:

```bash
pnpm chat hub cancel --invite-id 1
```

Rendezvous notes:

- phrases are normalized by trimming outer whitespace and lowercasing before commitment derivation
- punctuation still matters
- the contract never sees the secret or phrases
- the responder transaction is public, and accepted matches are public

## Contacts and verification

The local contact book is optional, but it makes the app much easier to use.

Commands:

```bash
pnpm chat contacts list
pnpm chat contacts save --address 0xPEER --alias alice --notes "met on testnet"
pnpm chat contacts show --with alice
pnpm chat contacts verify --with alice
pnpm chat contacts export --file ./contacts.json
pnpm chat contacts import --file ./contacts.json
```

Verification in v1 is local and manual: the CLI stores the current on-chain chat-key fingerprint and marks the contact as verified. It is still up to you to compare that fingerprint out of band.

## Local data files

By default, all local state lives under:

```text
~/.chatter-blocks/<chainId>/<walletAddress>/
```

You can override the base directory with `CHATTER_HOME`, which is useful for demos and tests.

Files:

- `keyring.json`: local X25519 chat keys by version, including historical keys needed to read older messages or invite responses after rotation
- `hub.json`: locally stored invite secrets, phrase pairs, invite commitments, response validation results, and accepted-match metadata
- `contacts.json`: aliases, notes, chain labels, verification state, fingerprints, and last-match timestamps
- `app-state.json`: draft text, unread markers, last-opened timestamps, and terminal-app settings

All of these files are local only. None of them are uploaded by the app. In v1 they are not encrypted at rest, so treat the machine as part of the trust boundary.

## Troubleshooting

`pnpm chat start` is the easiest recovery path because it checks the most common misconfigurations. If you prefer raw commands, these are the usual fixes:

- `Missing RPC URL`:
  set `CHATTER_RPC_URL` or pass `--rpc-url`.
- `Missing contract address`:
  set `CHATTER_CONTRACT_ADDRESS` to the deployed `ChatterBlocks` contract on the same chain as your RPC.
- `Missing private key`:
  set `CHATTER_PRIVATE_KEY` or pass `--private-key`.
- `No active chat key` or you cannot decrypt expected messages:
  run `pnpm chat setup`; if you intentionally want a new chat key, run `pnpm chat setup --rotate` or `pnpm chat start --rotate`.
- you reused an old `CHATTER_HOME` against a fresh local chain:
  `pnpm chat start` will now offer to register the existing local key on the new chain; if the local key and on-chain key truly diverge, use `pnpm chat start --rotate`.
- `Unknown contact address or alias`:
  check `pnpm chat contacts list` or save the contact first.
- invite response is invalid or an invite has expired:
  post a new invite and share the new `shareCode`.
- transaction fails with insufficient funds:
  fund the wallet on that chain; this app has no relay or sponsor.
- messages or invites look like they belong to the wrong environment:
  check that both users are pointing at the same `CHATTER_RPC_URL` and `CHATTER_CONTRACT_ADDRESS`.
- you want a clean local demo state:
  point each terminal at its own temporary `CHATTER_HOME`, for example `/tmp/chatter-blocks-alice` and `/tmp/chatter-blocks-bob`.
- `forge test` crashes in a sandboxed macOS shell:
  rerun it from a normal terminal session; some sandboxed environments have a Foundry/system proxy issue.

## CLI flags

The CLI resolves configuration in this order:

- `--rpc-url` over `CHATTER_RPC_URL`
- `--contract-address` over `CHATTER_CONTRACT_ADDRESS`
- `--private-key` over `CHATTER_PRIVATE_KEY`

Commands:

- `pnpm chat start`
- `pnpm chat app`
- `pnpm chat setup [--rotate]`
- `pnpm chat send --to <addressOrAlias> --message <text>`
- `pnpm chat contacts list`
- `pnpm chat contacts save --address <address> [--alias <alias>] [--notes <text>]`
- `pnpm chat contacts show --with <addressOrAlias>`
- `pnpm chat contacts verify --with <addressOrAlias>`
- `pnpm chat contacts export --file <path>`
- `pnpm chat contacts import --file <path>`
- `pnpm chat hub post --phrase <phraseA> --expect <phraseB> [--ttl-hours <hours>]`
- `pnpm chat hub list [--cursor <inviteId>] [--limit <count>]`
- `pnpm chat hub respond --bundle <shareCode>`
- `pnpm chat hub respond --invite-id <id> --phrase <phraseA> --reciprocal <phraseB> --secret <inviteSecret>`
- `pnpm chat hub responses --invite-id <id>`
- `pnpm chat hub accept --invite-id <id> --response-id <id>`
- `pnpm chat hub matches`
- `pnpm chat hub cancel --invite-id <id>`
- `pnpm chat inbox [--with <addressOrAlias>] [--cursor <messageId>] [--limit <count>] [--follow]`

Notes:

- plaintext messages are capped at `1024` UTF-8 bytes
- encrypted payloads are capped on-chain at `2048` bytes
- invite TTL defaults to 24 hours and must be between 1 hour and 7 days
- `--follow` polls every 2 seconds
- the app persists drafts and unread markers locally

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

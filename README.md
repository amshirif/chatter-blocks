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

Local secrets can now be encrypted at rest if you set `CHATTER_PASSPHRASE` or pass `--passphrase`:

- chat private keys live in `~/.chatter-blocks/<chainId>/<wallet>/keyring.json`
- rendezvous invite drafts and secrets live in `~/.chatter-blocks/<chainId>/<wallet>/hub.json`
- aliases, fingerprints, and notes live in `~/.chatter-blocks/<chainId>/<wallet>/contacts.json`
- drafts, unread markers, and terminal-app settings live in `~/.chatter-blocks/<chainId>/<wallet>/app-state.json`
- all files are written with `0600` permissions

By default:

- `keyring.json` and `hub.json` are plaintext unless a passphrase is configured
- `contacts.json` and `app-state.json` remain plaintext convenience metadata
- losing `keyring.json` can strand older messages or invite responses that depend on historical local key versions
- losing `hub.json` can prevent local invite-response validation and private invite recovery

## Requirements

- Node 22+
- `pnpm`
- `forge`, `anvil`, and `cast`

## Install

```bash
pnpm install
```

## Test

Fast local verification:

```bash
pnpm test
```

Targeted product-flow rerun against local Anvil:

```bash
pnpm test:e2e
```

`pnpm test` now includes the full local product-flow gate. `pnpm test:e2e` is the targeted rerun for that path.

The E2E suite starts a local chain, deploys the contract, drives the CLI through setup, rendezvous post/respond/accept, sends a real encrypted message, and drives `pnpm chat start` through the app flow with hub navigation, back, and quit checks.

## Config

The CLI and terminal app automatically load a local `.env` file from the repo root if it exists.

Precedence is:

- command flags
- existing shell environment and values loaded from `.env`
- interactive prompts in `pnpm chat start`

Optional local-secret encryption:

- set `CHATTER_PASSPHRASE` in your shell or `.env`
- or pass `--passphrase <text>` to `pnpm chat ...`
- or enter a passphrase during `pnpm chat start`

Optional developer timing output:

- set `CHATTER_TIMING=1` to emit app/workflow timing lines to `stderr`
- this is for local profiling only; it does not change the terminal UI output on `stdout`

Start from the included template:

```bash
cp .env.example .env
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

For a repeatable local demo, the repo now includes helper scripts:

```bash
pnpm demo:chain
pnpm demo:deploy
pnpm demo:fresh
pnpm demo:alice
pnpm demo:bob
pnpm demo:env
pnpm demo:status
pnpm demo:clean
```

Use them like this:

- `pnpm demo:fresh`: preferred path; starts a clean managed Anvil, deploys the contract, and prints Alice/Bob env blocks
- `pnpm demo:deploy`: deploys onto the current RPC and warns if that chain already has activity
- `pnpm demo:env`: reprints the current session env blocks
- `pnpm demo:status`: shows the current demo session plus managed-chain status
- `pnpm demo:clean`: clears the current demo session and stops any managed Anvil started by `pnpm demo:fresh`

Important: the smoothest first-run demo path requires a fresh local chain, not just fresh local homes. Reusing an older chain can legitimately trigger rotate/recovery prompts because the app sees existing on-chain chat-key history.

## Quick demo

This is the fastest way to see the product working from a fresh clone with two local users.

For the first technical-friend trial round, use the shorter field-test kit instead of improvising from the full README:

- [Tester runbook](/Users/amirshirif/Documents/personal/chatter-blocks/docs/field-test/runbook.md)
- [Feedback template](/Users/amirshirif/Documents/personal/chatter-blocks/docs/field-test/feedback-template.md)
- [Maintainer checklist](/Users/amirshirif/Documents/personal/chatter-blocks/docs/field-test/maintainer-checklist.md)

Use three terminals. This path intentionally starts a fresh managed local chain so Alice and Bob get the simplest first-run app flow.

Terminal 1 creates a clean local demo environment:

```bash
pnpm demo:fresh
```

This command:

- starts a clean managed Anvil instance
- deploys a fresh `ChatterBlocks` contract
- creates fresh Alice/Bob local homes
- prints the exact env blocks and session info

Terminal 2 is Alice. This example uses the first default Anvil account:

- wallet: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- private key: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`

Terminal 3 is Bob. This example uses the second default Anvil account:

- wallet: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`
- private key: `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`

```bash
pnpm demo:alice
```

Terminal 3 is Bob:

```bash
pnpm demo:bob
```

Once both apps are open:

1. Alice selects `1. Hub`, then `1. Post invite`, enters two phrases, and copies the full `shareCode` block.
2. Bob selects `1. Hub`, then `2. Respond with share code`, and pastes the `shareCode`.
3. Alice selects `1. Hub`, then `3. Review responses`, selects the invite, and accepts the numbered valid response.
4. Alice can choose `1. Open conversation` immediately after accept, or either side can open the match from home.
5. One side selects `1. Edit draft`, writes a message, then selects `2. Send message`.
6. The other side opens the same thread and sees the decrypted message.

If you want a pure command-line demo instead of the app, the low-level flow later in this README does the same thing with raw commands.

If you intentionally want to reuse an already-running chain instead of starting fresh, use:

```bash
pnpm demo:deploy
```

That path is valid, but it may lead the app into correct recovery/rotation prompts if the chain already has prior chat-key history.

## Fastest onboarding

If you want the friendliest entrypoint, use the setup wizard:

```bash
pnpm chat start
```

`chat start` asks for missing configuration, optionally asks for a local-state passphrase, checks local/on-chain chat key health, offers to register or rotate a key if needed, and then opens the terminal app.

If local secret files are encrypted and no passphrase is already configured, `chat start` now opens an explicit unlock screen before it performs health checks. You can retry unlock, back out to the blocking startup screen, or quit cleanly without crashing the app.

If you want to force a fresh local chat key rotation during startup:

```bash
pnpm chat start --rotate
```

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
- a settings screen for timestamp display

The app stays local. It calls the same low-level workflows as the raw CLI commands.

The current app is menu-driven. It is not a split-pane curses UI yet. You move between screens with numbered actions and fixed `b` for back / `q` for quit.

## Using the terminal app

The app has five main screens.

Home screen:

- shows wallet, chain, RPC, contract, status, conversations, invite count, match count, and saved-contact count
- actions: `1. Hub`, `2. Contacts`, `3. Settings`, `4. New conversation`, `5. Run setup`, `6. Refresh`, then conversation shortcuts starting at `7`

Conversation screen:

- shows the peer alias or short address, the local fingerprint record, verification state, recent decrypted messages, and the current draft
- actions: `1. Edit draft`, `2. Send message`, `3. Save contact`, `4. Verify contact`, `5. Refresh`, plus `b` and `q`

Hub screen:

- shows public active invites, your local invite records, and match count
- actions: `1. Post invite`, `2. Respond with share code`, `3. Review responses`, `4. View matches`, `5. Cancel invite`, `6. Show latest share bundle`, `7. Refresh`, plus `b` and `q`

Contacts screen:

- shows aliases, verification flags, and fingerprints
- actions: `1. Add contact`, `2. Export contacts`, `3. Import contacts`, `4. Refresh`, then saved-contact shortcuts starting at `5`, plus `b` and `q`

Settings screen:

- shows exact timestamp mode
- actions: `1. Toggle timestamps`, plus `b` and `q`

The first-run `chat start` wizard explains the privacy boundary, checks your RPC and contract configuration, optionally lets you set a passphrase for local secret files, checks whether your local chat key matches the on-chain key, and offers to register or rotate the key before opening the app.

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

All of these files are local only. None of them are uploaded by the app.

- `keyring.json` and `hub.json` are encrypted at rest if you configure `CHATTER_PASSPHRASE` or pass `--passphrase`
- `contacts.json` and `app-state.json` remain plaintext convenience metadata
- without a passphrase, all files remain part of the local trust boundary

## Backup and Recovery

If you care about older message history or posted invite recovery, back up local secret state before rotating keys or moving machines:

```bash
pnpm chat secrets export --file ./chatter-secrets.json
```

The secret backup contains:

- `keyring.json`
- `hub.json`
- the current wallet address
- the current chain id
- an export timestamp

It does not contain:

- `contacts.json`
- `app-state.json`
- public on-chain data

Restore the backup later with:

```bash
pnpm chat secrets import --file ./chatter-secrets.json
```

Inspect local secret state with:

```bash
pnpm chat secrets show
```

Notes:

- imports are wallet-scoped and chain-scoped; the backup must match the current wallet and RPC chain
- secret imports replace the current `keyring.json` and `hub.json`; they do not merge
- encrypted secret files stay encrypted in the backup; plaintext files stay plaintext
- passphrase protection only protects local-at-rest secret files, not public chain metadata
- restoring a backup does not recover anything that was never stored locally

## Troubleshooting

`pnpm chat start` is the easiest recovery path because it checks the most common misconfigurations. If you prefer raw commands, these are the usual fixes:

- `Missing RPC URL`:
  set `CHATTER_RPC_URL` or pass `--rpc-url`.
- `Missing contract address`:
  set `CHATTER_CONTRACT_ADDRESS` to the deployed `ChatterBlocks` contract on the same chain as your RPC.
- `Missing private key`:
  set `CHATTER_PRIVATE_KEY` or pass `--private-key`.
- `Keyring is encrypted` or `Hub state is encrypted`:
  set `CHATTER_PASSPHRASE`, pass `--passphrase`, or rerun `pnpm chat start` and enter the passphrase.
- `missing local key version ...` appears in previews, threads, or invite validation:
  restore a prior `pnpm chat secrets export` backup that still contains that historical key version before rotating again.
- `No active chat key` or you cannot decrypt expected messages:
  run `pnpm chat setup`; if you intentionally want a new chat key, run `pnpm chat setup --rotate`.
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
- `--passphrase` over `CHATTER_PASSPHRASE`

Commands:

- `pnpm chat start`
- `pnpm chat app`
- `pnpm chat setup [--rotate]`
- `pnpm chat send --to <addressOrAlias> --message <text>`
- `pnpm chat secrets export --file <path>`
- `pnpm chat secrets import --file <path>`
- `pnpm chat secrets show`
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

# ChatterBlocks Walkthrough Runbook

This runbook is for a 10-15 minute live demo aimed at technical builders. The goal is to prove the product works end to end without overspending time on setup or code internals.

## Demo goal

By the end of the walkthrough, the audience should have seen:

- two fresh local users register or confirm chat keys
- a chain-only rendezvous match happen through the hub
- a real encrypted message sent and decrypted
- the trust boundary stated correctly: no backend, but public on-chain metadata and plaintext local secrets in v1

## Before the audience joins

- run `pnpm install`
- start `anvil`
- deploy the contract
- prepare two clean shells:
  - Alice: `CHATTER_HOME=/tmp/chatter-blocks-alice`
  - Bob: `CHATTER_HOME=/tmp/chatter-blocks-bob`
- export `CHATTER_RPC_URL`, `CHATTER_CONTRACT_ADDRESS`, and the correct `CHATTER_PRIVATE_KEY` in each shell
- keep [README.md](/Users/amirshirif/Documents/personal/chatter-blocks/README.md) open to the Quick Demo and Troubleshooting sections
- keep [scripts/walkthrough-fallback.sh](/Users/amirshirif/Documents/personal/chatter-blocks/scripts/walkthrough-fallback.sh) ready in case the app flow becomes awkward live

## Minute-by-minute flow

### Minute 0-1: frame the product

Say:

- “This is a chain-only E2E chat MVP for EVM chains.”
- “There is no backend, relay, indexer, or hosted service.”
- “Wallets authorize transactions; separate chat keys handle encryption.”

Show:

- the repo root
- the README Quick Demo section

### Minute 1-2: set the privacy boundary

Say:

- message plaintext stays off-chain
- rendezvous secrets and phrases stay off-chain
- addresses, timing, ciphertext size, and accepted matches are still public
- local chat keys and invite secrets are stored locally and are not encrypted at rest in v1

Keep the wording “chain-only, best-effort privacy rendezvous.” Do not call it anonymous.

### Minute 2-8: run the live demo

Alice shell:

```bash
pnpm chat start
```

Bob shell:

```bash
pnpm chat start
```

Inside the app:

1. Alice chooses `hub`.
2. Alice chooses `post`.
3. Alice enters phrase A and phrase B.
4. Alice copies the printed `shareCode`.
5. Bob chooses `hub`.
6. Bob chooses `respond`.
7. Bob pastes the `shareCode`.
8. Alice chooses `hub`.
9. Alice chooses `review`.
10. Alice enters the invite ID and accepts Bob’s response.
11. Bob opens the conversation and sends a message.
12. Alice opens the same conversation and shows the decrypted message.
13. Alice or Bob opens `contacts` or the thread view and shows the stored fingerprint and verification surface.

Success moment:

- make sure the audience clearly sees Bob’s message decrypted on Alice’s side

### Minute 8-11: explain how it works

Keep this to three ideas:

- the contract stores compact indexes and emits ciphertext in logs
- the CLI and app handle X25519 keys, encryption, decryption, contacts, drafts, and local state
- the terminal app is only a UX layer over the same low-level commands

### Minute 11-13: show the scriptability angle

Point to the raw commands in [README.md](/Users/amirshirif/Documents/personal/chatter-blocks/README.md):

- `hub post`
- `hub respond`
- `hub responses`
- `hub accept`
- `send`
- `inbox`

Say:

- “The app is convenience, not hidden infrastructure.”
- “If the app is clumsy live, the same flow works directly through the CLI.”

### Minute 13-15: Q&A buffer

Expected questions:

- what is public on-chain?
- how does key rotation work?
- how do contacts get verified?
- why no backend?
- what is still missing for production readiness?

Recommended answers:

- it works as an MVP
- it is not production-ready security
- the biggest current caveat is plaintext local secret storage

## Fallback CLI flow

If the app becomes awkward, switch to the CLI immediately and say the app and CLI call the same workflows underneath.

In either Alice or Bob shell, use the helper:

```bash
bash scripts/walkthrough-fallback.sh help
```

The same helper is also available as `pnpm run walkthrough:fallback help`.

Typical fallback sequence:

Alice shell:

```bash
bash scripts/walkthrough-fallback.sh setup
bash scripts/walkthrough-fallback.sh post "paper boat" "silver tide"
```

Bob shell:

```bash
bash scripts/walkthrough-fallback.sh setup
bash scripts/walkthrough-fallback.sh respond YOUR_SHARE_CODE
```

Alice shell:

```bash
bash scripts/walkthrough-fallback.sh responses 1
bash scripts/walkthrough-fallback.sh accept 1 1
```

Bob shell:

```bash
bash scripts/walkthrough-fallback.sh send 0xALICE_WALLET_ADDRESS "rendezvous worked"
```

Alice shell:

```bash
bash scripts/walkthrough-fallback.sh inbox 0xBOB_WALLET_ADDRESS
```

## Demo hygiene

- use clean `CHATTER_HOME` directories every time
- do not waste audience time on installs or environment setup
- keep both Alice and Bob shells visible or easy to swap between
- keep the README open as the source of truth if someone asks how to reproduce it

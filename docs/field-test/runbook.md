# ChatterBlocks Field-Test Runbook

This runbook is for the first field test with technical friends. It is intentionally shorter than the main [README](/Users/amirshirif/Documents/personal/chatter-blocks/README.md) and uses the app-first path only.

## Goal

Get from fresh local setup to one successful exchanged message between Alice and Bob.

## Requirements

- Node 22+
- `pnpm`
- Foundry tools installed: `forge`, `anvil`, `cast`

Optional:

- run `pnpm test` first if you want to verify the repo locally before trying the product

## Core Flow

Open three terminals in the repo root.

### Terminal 1: fresh local demo environment

```bash
pnpm install
pnpm demo:fresh
```

This starts a clean managed local Anvil instance, deploys a fresh contract, and prepares fresh Alice/Bob local state.

### Terminal 2: Alice

```bash
pnpm demo:alice
```

In the app:

1. Select `1. Hub`
2. Select `1. Post invite`
3. Enter any two phrases you want
4. Copy the full `shareCode` block

### Terminal 3: Bob

```bash
pnpm demo:bob
```

In the app:

1. Select `1. Hub`
2. Select `2. Respond with share code`
3. Paste Alice’s full `shareCode`

### Back to Alice

1. Select `1. Hub`
2. Select `3. Review responses`
3. Select the invite
4. Accept the valid response
5. Open the conversation from the match screen

### Exchange one message

On either side:

1. Select `1. Edit draft`
2. Type a message
3. Select `2. Send message`

On the other side:

1. Open the same conversation if it is not already open
2. Select `5. Refresh`
3. Confirm the decrypted message appears

## Secondary Scenario

If time allows, try encrypted local-state unlock:

1. Set `CHATTER_PASSPHRASE` in the shell before launch
2. Start the app again
3. Confirm the unlock flow is understandable
4. Check local secret state from:

```bash
pnpm chat secrets show
```

or from the in-app settings screen

## Recovery Scenario

If time allows, try one backup and recovery flow:

1. Export local secrets:

```bash
pnpm chat secrets export --file ./chatter-secrets.json
```

2. Simulate loss of older local key material only if the maintainer asks you to
3. Confirm degraded copy is understandable
4. Restore the backup:

```bash
pnpm chat secrets import --file ./chatter-secrets.json
```

5. Confirm older history is readable again

## What To Record

Please note:

- whether you completed the core flow
- any step where you hesitated or got lost
- any confusing wording
- any command or app step you had to retry
- whether invites, matches, and backups made sense to you

If something fails badly, stop and record the exact command/screen where it happened.

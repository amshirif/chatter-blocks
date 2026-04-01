import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import { bytesToHex } from "viem";

import {
  formatChatKeyFingerprint,
  importContactsState,
  readContacts,
  resolveContactAddress,
  upsertContact,
  writeContacts
} from "../contacts.js";
import {
  getUnreadCount,
  readAppState,
  upsertConversationState,
  writeAppState
} from "../app-state.js";
import { decryptEnvelopeHex, encryptEnvelope } from "../crypto.js";
import {
  decryptAndValidateInviteResponse,
  deriveInviteCommitment,
  encryptInviteResponseEnvelope,
  extractMatchPeer,
  formatInviteSummary,
  readHubState,
  upsertHubInviteRecord,
  upsertHubResponseRecord,
  writeHubState
} from "../hub.js";
import { decryptMessageRecord } from "../messages.js";
import {
  createChatKeypair,
  getActiveLocalKey,
  getLocalKey,
  readKeyring,
  upsertKeyMaterial,
  writeKeyring
} from "../keyring.js";
import {
  decodeInviteShareCode,
  encodeInviteShareCode,
  resolveSetupStrategy
} from "../workflows.js";

const ALICE = "0x1000000000000000000000000000000000000001";
const BOB = "0x2000000000000000000000000000000000000002";

test("keyring persistence keeps older versions and updates the active version", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-"));

  try {
    const firstPair = createChatKeypair();
    let keyring = upsertKeyMaterial({
      keyring: null,
      chainId: 31337,
      walletAddress: ALICE,
      version: 1,
      publicKey: firstPair.publicKey,
      secretKey: firstPair.secretKey
    });
    await writeKeyring({
      chainId: 31337,
      walletAddress: ALICE,
      keyring,
      baseDir
    });

    const secondPair = createChatKeypair();
    keyring = upsertKeyMaterial({
      keyring,
      chainId: 31337,
      walletAddress: ALICE,
      version: 2,
      publicKey: secondPair.publicKey,
      secretKey: secondPair.secretKey
    });
    await writeKeyring({
      chainId: 31337,
      walletAddress: ALICE,
      keyring,
      baseDir
    });

    const stored = await readKeyring({
      chainId: 31337,
      walletAddress: ALICE,
      baseDir
    });

    assert.equal(stored.activeVersion, 2);
    assert.equal(bytesToHex(getLocalKey(stored, 1).publicKey), bytesToHex(firstPair.publicKey));
    assert.equal(bytesToHex(getActiveLocalKey(stored).publicKey), bytesToHex(secondPair.publicKey));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("encryption roundtrip succeeds for the recipient and fails for the wrong key", () => {
  const alicePair = createChatKeypair();
  const bobPair = createChatKeypair();
  const evePair = createChatKeypair();
  const encrypted = encryptEnvelope({
    text: "hello chain",
    senderSecretKey: alicePair.secretKey,
    recipientPublicKey: bobPair.publicKey,
    nonceBytes: new Uint8Array(24).fill(7)
  });

  const opened = decryptEnvelopeHex({
    nonceHex: encrypted.nonceHex,
    ciphertextHex: encrypted.ciphertextHex,
    viewerSecretKey: bobPair.secretKey,
    peerPublicKeyHex: bytesToHex(alicePair.publicKey)
  });
  const failed = decryptEnvelopeHex({
    nonceHex: encrypted.nonceHex,
    ciphertextHex: encrypted.ciphertextHex,
    viewerSecretKey: evePair.secretKey,
    peerPublicKeyHex: bytesToHex(alicePair.publicKey)
  });

  assert.equal(opened.text, "hello chain");
  assert.equal(failed, null);
});

test("message reconstruction decrypts both sides of a two-way conversation", async () => {
  const alicePair = createChatKeypair();
  const bobPair = createChatKeypair();
  const aliceKeyring = upsertKeyMaterial({
    keyring: null,
    chainId: 31337,
    walletAddress: ALICE,
    version: 1,
    publicKey: alicePair.publicKey,
    secretKey: alicePair.secretKey
  });
  const firstMessage = encryptEnvelope({
    text: "hey bob",
    senderSecretKey: alicePair.secretKey,
    recipientPublicKey: bobPair.publicKey,
    nonceBytes: new Uint8Array(24).fill(1)
  });
  const secondMessage = encryptEnvelope({
    text: "hey alice",
    senderSecretKey: bobPair.secretKey,
    recipientPublicKey: alicePair.publicKey,
    nonceBytes: new Uint8Array(24).fill(2)
  });
  const resolveChatKey = async (account, version) => {
    if (version !== 1n) {
      return null;
    }

    if (account.toLowerCase() === ALICE.toLowerCase()) {
      return bytesToHex(alicePair.publicKey);
    }

    if (account.toLowerCase() === BOB.toLowerCase()) {
      return bytesToHex(bobPair.publicKey);
    }

    return null;
  };

  const outgoing = await decryptMessageRecord({
    header: {
      conversationId: "0x1",
      sender: ALICE,
      recipient: BOB,
      sentAt: 1n,
      blockNumber: 1n,
      senderKeyVersion: 1n,
      recipientKeyVersion: 1n,
      nonce: firstMessage.nonceHex,
      ciphertextHash: "0x0"
    },
    ciphertextHex: firstMessage.ciphertextHex,
    viewerAddress: ALICE,
    keyring: aliceKeyring,
    resolveChatKey
  });
  const incoming = await decryptMessageRecord({
    header: {
      conversationId: "0x1",
      sender: BOB,
      recipient: ALICE,
      sentAt: 2n,
      blockNumber: 2n,
      senderKeyVersion: 1n,
      recipientKeyVersion: 1n,
      nonce: secondMessage.nonceHex,
      ciphertextHash: "0x0"
    },
    ciphertextHex: secondMessage.ciphertextHex,
    viewerAddress: ALICE,
    keyring: aliceKeyring,
    resolveChatKey
  });

  assert.equal(outgoing.direction, "out");
  assert.equal(outgoing.text, "hey bob");
  assert.equal(incoming.direction, "in");
  assert.equal(incoming.text, "hey alice");
});

test("invite commitment derivation normalizes case and surrounding whitespace", () => {
  const inviteSecret = `0x${"11".repeat(32)}`;
  const normalizedCommitment = deriveInviteCommitment({
    inviteSecret,
    phraseA: "hello there",
    phraseB: "silver tide"
  });
  const spacedCommitment = deriveInviteCommitment({
    inviteSecret,
    phraseA: "  HELLO THERE  ",
    phraseB: "  SILVER TIDE  "
  });
  const punctuatedCommitment = deriveInviteCommitment({
    inviteSecret,
    phraseA: "hello there!",
    phraseB: "silver tide"
  });

  assert.equal(spacedCommitment, normalizedCommitment);
  assert.notEqual(punctuatedCommitment, normalizedCommitment);
});

test("invite response envelopes decrypt for the poster and reject mismatched metadata", () => {
  const alicePair = createChatKeypair();
  const bobPair = createChatKeypair();
  const inviteCommitment = `0x${"22".repeat(32)}`;
  const aliceKeyring = upsertKeyMaterial({
    keyring: null,
    chainId: 31337,
    walletAddress: ALICE,
    version: 1,
    publicKey: alicePair.publicKey,
    secretKey: alicePair.secretKey
  });
  const invite = {
    poster: ALICE,
    postedAt: 100n,
    expiresAt: 200n,
    posterKeyVersion: 1n,
    inviteCommitment,
    status: 1
  };
  const responseHeader = {
    inviteId: 7n,
    responder: BOB,
    submittedAt: 150n,
    blockNumber: 4n,
    responderKeyVersion: 1n,
    ciphertextHash: "0x0",
    status: 1
  };
  const encrypted = encryptInviteResponseEnvelope({
    inviteCommitment,
    responderWallet: BOB,
    responderKeyVersion: 1n,
    responderSecretKey: bobPair.secretKey,
    posterPublicKey: alicePair.publicKey,
    nonceBytes: new Uint8Array(24).fill(9)
  });

  const valid = decryptAndValidateInviteResponse({
    invite,
    responseHeader,
    ciphertextHex: encrypted.ciphertextHex,
    keyring: aliceKeyring,
    responderPublicKeyHex: bytesToHex(bobPair.publicKey),
    inviteCommitment
  });
  const wrongCommitment = decryptAndValidateInviteResponse({
    invite,
    responseHeader,
    ciphertextHex: encrypted.ciphertextHex,
    keyring: aliceKeyring,
    responderPublicKeyHex: bytesToHex(bobPair.publicKey),
    inviteCommitment: `0x${"33".repeat(32)}`
  });
  const wrongMetadata = decryptAndValidateInviteResponse({
    invite,
    responseHeader: {
      ...responseHeader,
      responderKeyVersion: 2n
    },
    ciphertextHex: encrypted.ciphertextHex,
    keyring: aliceKeyring,
    responderPublicKeyHex: bytesToHex(bobPair.publicKey),
    inviteCommitment
  });

  assert.equal(valid.valid, true);
  assert.equal(valid.decrypted, true);
  assert.equal(valid.envelope.responderWallet, BOB.toLowerCase());
  assert.equal(valid.envelope.responderKeyVersion, 1);
  assert.equal(wrongCommitment.valid, false);
  assert.equal(wrongCommitment.commitmentMatches, false);
  assert.equal(wrongMetadata.valid, false);
  assert.equal(wrongMetadata.metadataMatches, false);
});

test("hub state persistence tracks posted invites, responses, and accepted matches", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-hub-"));

  try {
    let hubState = upsertHubInviteRecord({
      hubState: null,
      chainId: 31337,
      walletAddress: ALICE,
      inviteId: 7n,
      role: "poster",
      inviteSecret: `0x${"22".repeat(32)}`,
      phraseA: "alpha",
      phraseB: "beta",
      inviteCommitment: `0x${"44".repeat(32)}`,
      posterWalletAddress: ALICE,
      posterKeyVersion: 1,
      expiresAt: 1234n,
      status: "ACTIVE"
    });
    hubState = upsertHubResponseRecord({
      hubState,
      chainId: 31337,
      walletAddress: ALICE,
      inviteId: 7n,
      responseId: 9n,
      responderWalletAddress: BOB,
      responderKeyVersion: 2,
      submittedAt: 1300n,
      status: "ACTIVE",
      decrypted: true,
      commitmentMatches: true,
      metadataMatches: true,
      createdAt: 777,
      validationError: null
    });
    hubState = upsertHubInviteRecord({
      hubState,
      chainId: 31337,
      walletAddress: ALICE,
      inviteId: 7n,
      status: "MATCHED",
      peerWalletAddress: BOB,
      peerKeyVersion: 3,
      matchedAt: 2345n,
      acceptedResponseId: 9n
    });
    hubState = upsertHubResponseRecord({
      hubState,
      chainId: 31337,
      walletAddress: ALICE,
      inviteId: 7n,
      responseId: 9n,
      status: "ACCEPTED"
    });
    await writeHubState({
      chainId: 31337,
      walletAddress: ALICE,
      hubState,
      baseDir
    });

    const stored = await readHubState({
      chainId: 31337,
      walletAddress: ALICE,
      baseDir
    });

    assert.equal(stored.invites["7"].status, "MATCHED");
    assert.equal(stored.invites["7"].inviteCommitment, `0x${"44".repeat(32)}`);
    assert.equal(stored.invites["7"].acceptedResponseId, "9");
    assert.equal(stored.invites["7"].peerWalletAddress, BOB.toLowerCase());
    assert.equal(stored.invites["7"].responses["9"].status, "ACCEPTED");
    assert.equal(stored.invites["7"].responses["9"].metadataMatches, true);
    assert.equal(stored.invites["7"].responses["9"].createdAt, 777);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("invite summaries and match extraction render usable peer metadata", () => {
  const summary = formatInviteSummary({
    inviteId: 5n,
    invite: {
      poster: ALICE,
      postedAt: 100n,
      expiresAt: 3700n,
      status: 1
    },
    nowMs: 700000
  });
  const peer = extractMatchPeer({
    viewerAddress: BOB,
    inviteMatch: {
      inviteId: 5n,
      poster: ALICE,
      responder: BOB,
      posterKeyVersion: 1n,
      responderKeyVersion: 2n
    }
  });

  assert.match(summary, /#5 ACTIVE poster=0x1000\.\.\.0001/);
  assert.match(summary, /expires=/);
  assert.deepEqual(peer, {
    role: "responder",
    peerWalletAddress: ALICE.toLowerCase(),
    peerKeyVersion: 1
  });
});

test("contacts support aliases, fingerprint formatting, and import merging", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-contacts-"));

  try {
    let contacts = upsertContact({
      contacts: null,
      chainId: 31337,
      walletAddress: ALICE,
      address: BOB,
      alias: "Bob",
      notes: "friend",
      fingerprint: formatChatKeyFingerprint(`0x${"ab".repeat(32)}`)
    });
    contacts = upsertContact({
      contacts,
      chainId: 31337,
      walletAddress: ALICE,
      address: "0x3000000000000000000000000000000000000003",
      alias: "Carol"
    });
    await writeContacts({
      chainId: 31337,
      walletAddress: ALICE,
      contacts,
      baseDir
    });

    const stored = await readContacts({
      chainId: 31337,
      walletAddress: ALICE,
      baseDir
    });
    const merged = importContactsState({
      contacts: stored,
      importedContacts: {
        schemaVersion: 1,
        chainId: "31337",
        walletAddress: ALICE,
        contacts: {
          [BOB]: {
            address: BOB,
            alias: "Bob",
            verified: true,
            verifiedAt: "2026-03-14T00:00:00.000Z"
          }
        }
      },
      chainId: 31337,
      walletAddress: ALICE
    });

    assert.equal(resolveContactAddress({ contacts: stored, reference: "bob" }), BOB);
    assert.equal(merged.contacts[BOB.toLowerCase()].verified, true);
    assert.match(stored.contacts[BOB.toLowerCase()].fingerprint, /ABAB-ABAB/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("app state persists drafts and unread counts", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-app-state-"));

  try {
    let appState = upsertConversationState({
      appState: null,
      chainId: 31337,
      walletAddress: ALICE,
      peerWalletAddress: BOB,
      draft: "hello draft",
      lastSeenMessageId: 2n
    });
    await writeAppState({
      chainId: 31337,
      walletAddress: ALICE,
      appState,
      baseDir
    });

    const stored = await readAppState({
      chainId: 31337,
      walletAddress: ALICE,
      baseDir
    });
    const unreadCount = getUnreadCount({
      appState: stored,
      peerWalletAddress: BOB,
      records: [
        { messageId: 1n, direction: "in" },
        { messageId: 2n, direction: "out" },
        { messageId: 3n, direction: "in" },
        { messageId: 4n, direction: "out" }
      ]
    });

    assert.equal(stored.conversations[BOB.toLowerCase()].draft, "hello draft");
    assert.equal(stored.conversations[BOB.toLowerCase()].lastSeenMessageId, "2");
    assert.equal(unreadCount, 1);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("share bundle codes roundtrip without losing invite details", () => {
  const shareCode = encodeInviteShareCode({
    inviteId: 11n,
    inviteSecret: `0x${"44".repeat(32)}`,
    phraseA: "paper boat",
    phraseB: "silver tide"
  });
  const decoded = decodeInviteShareCode(shareCode);

  assert.deepEqual(decoded, {
    inviteId: "11",
    inviteSecret: `0x${"44".repeat(32)}`,
    phraseA: "paper boat",
    phraseB: "silver tide"
  });
});

test("setup strategy reuses a local key when the chain has no registered key", () => {
  const pair = createChatKeypair();
  const keyring = upsertKeyMaterial({
    keyring: null,
    chainId: 31337,
    walletAddress: ALICE,
    version: 4,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey
  });

  const strategy = resolveSetupStrategy({
    rotate: false,
    keyring,
    onChainKey: {
      version: 0n,
      pubKey: `0x${"00".repeat(32)}`
    }
  });

  assert.equal(strategy.action, "reuse-local-key");
  assert.equal(bytesToHex(strategy.localKey.publicKey), bytesToHex(pair.publicKey));
});

test("setup strategy requires rotation when the on-chain key and local key diverge", () => {
  const pair = createChatKeypair();
  const keyring = upsertKeyMaterial({
    keyring: null,
    chainId: 31337,
    walletAddress: ALICE,
    version: 1,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey
  });

  const strategy = resolveSetupStrategy({
    rotate: false,
    keyring,
    onChainKey: {
      version: 2n,
      pubKey: `0x${"ff".repeat(32)}`
    }
  });

  assert.equal(strategy.action, "rotation-required");
  assert.match(strategy.message, /chat start --rotate/);
});

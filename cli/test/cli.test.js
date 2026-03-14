import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import { bytesToHex } from "viem";

import { decryptEnvelopeHex, encryptEnvelope } from "../crypto.js";
import { decryptMessageRecord } from "../messages.js";
import {
  createChatKeypair,
  getActiveLocalKey,
  getLocalKey,
  readKeyring,
  upsertKeyMaterial,
  writeKeyring
} from "../keyring.js";

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

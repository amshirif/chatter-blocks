import { randomBytes } from "node:crypto";

import nacl from "tweetnacl";
import { bytesToHex, hexToBytes } from "viem";

export const MAX_PLAINTEXT_MESSAGE_BYTES = 1024;

function encodeJsonPayload(payload, maxBytes) {
  const plaintext = Uint8Array.from(Buffer.from(JSON.stringify(payload), "utf8"));
  if (plaintext.length > maxBytes) {
    throw new Error(`Payload exceeds ${maxBytes} UTF-8 bytes.`);
  }

  return plaintext;
}

function openJsonPayload({ nonceBytes, ciphertextBytes, viewerSecretKey, peerPublicKeyHex }) {
  try {
    const plaintext = nacl.box.open(
      ciphertextBytes,
      nonceBytes,
      hexToBytes(peerPublicKeyHex),
      viewerSecretKey
    );

    if (!plaintext) {
      return null;
    }

    return JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch {
    return null;
  }
}

export function encryptEnvelope({ text, senderSecretKey, recipientPublicKey, nonceBytes }) {
  const messageSize = Buffer.byteLength(text, "utf8");
  if (messageSize > MAX_PLAINTEXT_MESSAGE_BYTES) {
    throw new Error(`Message exceeds ${MAX_PLAINTEXT_MESSAGE_BYTES} UTF-8 bytes.`);
  }

  const envelope = {
    v: 1,
    text,
    createdAt: Date.now()
  };

  const plaintext = encodeJsonPayload(envelope, MAX_PLAINTEXT_MESSAGE_BYTES);
  const nonce = nonceBytes ?? randomBytes(24);
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey);

  return {
    envelope,
    nonce,
    ciphertext,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ciphertext)
  };
}

export function decryptEnvelopeHex({ nonceHex, ciphertextHex, viewerSecretKey, peerPublicKeyHex }) {
  const parsed = openJsonPayload({
    nonceBytes: hexToBytes(nonceHex),
    ciphertextBytes: hexToBytes(ciphertextHex),
    viewerSecretKey,
    peerPublicKeyHex
  });

  if (!parsed || parsed?.v !== 1 || typeof parsed.text !== "string" || typeof parsed.createdAt !== "number") {
    return null;
  }

  return parsed;
}

export function encryptPackedJsonHex({
  payload,
  senderSecretKey,
  recipientPublicKey,
  nonceBytes,
  maxPlaintextBytes = MAX_PLAINTEXT_MESSAGE_BYTES
}) {
  const plaintext = encodeJsonPayload(payload, maxPlaintextBytes);
  const nonce = nonceBytes ?? randomBytes(24);
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey);
  const packed = new Uint8Array(nonce.length + ciphertext.length);

  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);

  return {
    payload,
    nonce,
    ciphertext,
    packedCiphertext: packed,
    ciphertextHex: bytesToHex(packed)
  };
}

export function decryptPackedJsonHex({ ciphertextHex, viewerSecretKey, peerPublicKeyHex }) {
  try {
    const packed = hexToBytes(ciphertextHex);
    if (packed.length <= 24) {
      return null;
    }

    return openJsonPayload({
      nonceBytes: packed.slice(0, 24),
      ciphertextBytes: packed.slice(24),
      viewerSecretKey,
      peerPublicKeyHex
    });
  } catch {
    return null;
  }
}

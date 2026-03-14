import { randomBytes } from "node:crypto";

import nacl from "tweetnacl";
import { bytesToHex, hexToBytes } from "viem";

export const MAX_PLAINTEXT_MESSAGE_BYTES = 1024;

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

  const plaintext = Uint8Array.from(Buffer.from(JSON.stringify(envelope), "utf8"));
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
  try {
    const plaintext = nacl.box.open(
      hexToBytes(ciphertextHex),
      hexToBytes(nonceHex),
      hexToBytes(peerPublicKeyHex),
      viewerSecretKey
    );

    if (!plaintext) {
      return null;
    }

    const parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    if (parsed?.v !== 1 || typeof parsed.text !== "string" || typeof parsed.createdAt !== "number") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

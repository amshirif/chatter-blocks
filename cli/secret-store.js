import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SECRET_FILE_SCHEMA_VERSION = 1;
const SECRET_KDF = "scrypt";
const SECRET_CIPHER = "aes-256-gcm";

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32);
}

function encodeBase64(value) {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value) {
  return Buffer.from(value, "base64");
}

export function defaultPassphrase() {
  return process.env.CHATTER_PASSPHRASE || null;
}

export function isEncryptedSecretEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.encrypted === true &&
    typeof value.ciphertext === "string"
  );
}

export function encryptJsonObject(payload, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(SECRET_CIPHER, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    schemaVersion: SECRET_FILE_SCHEMA_VERSION,
    encrypted: true,
    kdf: SECRET_KDF,
    cipher: SECRET_CIPHER,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    authTag: encodeBase64(authTag),
    ciphertext: encodeBase64(ciphertext)
  };
}

export function decryptJsonObject(envelope, passphrase) {
  try {
    const salt = decodeBase64(envelope.salt);
    const iv = decodeBase64(envelope.iv);
    const authTag = decodeBase64(envelope.authTag);
    const ciphertext = decodeBase64(envelope.ciphertext);
    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv(SECRET_CIPHER, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Invalid passphrase or corrupted encrypted local state.");
  }
}

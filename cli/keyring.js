import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import nacl from "tweetnacl";
import { bytesToHex, getAddress } from "viem";

function defaultBaseDir() {
  return process.env.CHATTER_HOME || path.join(os.homedir(), ".chatter-blocks");
}

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export function getWalletStateDir({ chainId, walletAddress, baseDir = defaultBaseDir() }) {
  return path.join(baseDir, String(chainId), getAddress(walletAddress).toLowerCase());
}

export function getKeyringPath({ chainId, walletAddress, baseDir = defaultBaseDir() }) {
  return path.join(getWalletStateDir({ chainId, walletAddress, baseDir }), "keyring.json");
}

export async function readKeyring({ chainId, walletAddress, baseDir = defaultBaseDir() }) {
  try {
    const filePath = getKeyringPath({ chainId, walletAddress, baseDir });
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeKeyring({ chainId, walletAddress, keyring, baseDir = defaultBaseDir() }) {
  const filePath = getKeyringPath({ chainId, walletAddress, baseDir });
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(keyring, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(filePath, 0o600);
  return filePath;
}

export function createChatKeypair() {
  return nacl.box.keyPair();
}

export function upsertKeyMaterial({ keyring, chainId, walletAddress, version, publicKey, secretKey }) {
  const normalizedAddress = getAddress(walletAddress).toLowerCase();
  const nextKeyring = keyring || {
    schemaVersion: 1,
    chainId: String(chainId),
    walletAddress: normalizedAddress,
    activeVersion: 0,
    keys: {}
  };

  nextKeyring.schemaVersion = 1;
  nextKeyring.chainId = String(chainId);
  nextKeyring.walletAddress = normalizedAddress;
  nextKeyring.keys ||= {};
  nextKeyring.keys[String(version)] = {
    publicKey: encodeBase64(publicKey),
    secretKey: encodeBase64(secretKey),
    createdAt: new Date().toISOString()
  };
  nextKeyring.activeVersion = Number(version);

  return nextKeyring;
}

export function getLocalKey(keyring, version) {
  const keyRecord = keyring?.keys?.[String(version)];
  if (!keyRecord) {
    return null;
  }

  return {
    version: Number(version),
    publicKey: decodeBase64(keyRecord.publicKey),
    secretKey: decodeBase64(keyRecord.secretKey),
    createdAt: keyRecord.createdAt || null
  };
}

export function getActiveLocalKey(keyring) {
  if (!keyring?.activeVersion) {
    return null;
  }

  return getLocalKey(keyring, keyring.activeVersion);
}

export function localKeyMatchesOnChain({ keyring, onChainVersion, onChainPubKey }) {
  const activeKey = getActiveLocalKey(keyring);
  if (!activeKey) {
    return false;
  }

  return (
    BigInt(activeKey.version) === BigInt(onChainVersion) &&
    bytesToHex(activeKey.publicKey).toLowerCase() === onChainPubKey.toLowerCase()
  );
}

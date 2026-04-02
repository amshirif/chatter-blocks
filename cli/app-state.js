import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { getAddress } from "viem";

import { getWalletStateDir } from "./keyring.js";

const APP_STATE_SCHEMA_VERSION = 1;

function normalizeConversationRecord(address, record) {
  return {
    peerWalletAddress: getAddress(address).toLowerCase(),
    lastSeenMessageId: record.lastSeenMessageId ? String(record.lastSeenMessageId) : null,
    draft: record.draft ?? "",
    lastOpenedAt: record.lastOpenedAt ?? null,
    updatedAt: new Date().toISOString()
  };
}

function normalizeSettings(settings) {
  return {
    showExactTimestamps: Boolean(settings?.showExactTimestamps)
  };
}

function normalizeAppState(appState, chainId, walletAddress) {
  const normalizedWalletAddress = getAddress(walletAddress).toLowerCase();
  const nextState = {
    schemaVersion: APP_STATE_SCHEMA_VERSION,
    chainId: String(chainId),
    walletAddress: normalizedWalletAddress,
    conversations: {},
    settings: normalizeSettings(appState?.settings)
  };

  for (const [address, record] of Object.entries(appState?.conversations ?? {})) {
    nextState.conversations[getAddress(address).toLowerCase()] = normalizeConversationRecord(address, record);
  }

  return nextState;
}

export function getAppStatePath({ chainId, walletAddress, baseDir }) {
  return path.join(getWalletStateDir({ chainId, walletAddress, baseDir }), "app-state.json");
}

export async function readAppState({ chainId, walletAddress, baseDir }) {
  try {
    const filePath = getAppStatePath({ chainId, walletAddress, baseDir });
    const contents = await readFile(filePath, "utf8");
    return normalizeAppState(JSON.parse(contents), chainId, walletAddress);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeAppState({ chainId, walletAddress, appState, baseDir }) {
  const filePath = getAppStatePath({ chainId, walletAddress, baseDir });
  const nextState = normalizeAppState(appState, chainId, walletAddress);

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);

  return filePath;
}

export function getConversationState(appState, peerWalletAddress) {
  return appState?.conversations?.[getAddress(peerWalletAddress).toLowerCase()] ?? null;
}

export function upsertConversationState({
  appState,
  chainId,
  walletAddress,
  peerWalletAddress,
  lastSeenMessageId,
  draft,
  lastOpenedAt
}) {
  const nextState = normalizeAppState(appState, chainId, walletAddress);
  const normalizedPeer = getAddress(peerWalletAddress).toLowerCase();
  const existing = nextState.conversations[normalizedPeer];

  nextState.conversations[normalizedPeer] = normalizeConversationRecord(normalizedPeer, {
    ...existing,
    lastSeenMessageId:
      lastSeenMessageId !== undefined
        ? (lastSeenMessageId === null ? null : String(lastSeenMessageId))
        : existing?.lastSeenMessageId ?? null,
    draft: draft !== undefined ? draft : existing?.draft ?? "",
    lastOpenedAt: lastOpenedAt !== undefined ? lastOpenedAt : existing?.lastOpenedAt ?? null
  });

  return nextState;
}

export function updateAppSettings({ appState, chainId, walletAddress, settings }) {
  const nextState = normalizeAppState(appState, chainId, walletAddress);
  nextState.settings = normalizeSettings({
    ...nextState.settings,
    ...settings
  });
  return nextState;
}

export function getUnreadCount({ appState, peerWalletAddress, records }) {
  const conversationState = getConversationState(appState, peerWalletAddress);
  if (!records?.length) {
    return 0;
  }

  const lastSeenMessageId = conversationState?.lastSeenMessageId ? BigInt(conversationState.lastSeenMessageId) : 0n;
  return records.filter((record) => {
    if (record.messageId <= lastSeenMessageId) {
      return false;
    }

    return record.direction ? record.direction === "in" : true;
  }).length;
}

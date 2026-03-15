import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { getAddress, isAddress } from "viem";

import { getWalletStateDir } from "./keyring.js";

const CONTACTS_SCHEMA_VERSION = 1;

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeAlias(alias) {
  if (alias === undefined || alias === null) {
    return null;
  }

  const trimmed = String(alias).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function normalizeNotes(notes) {
  if (notes === undefined || notes === null) {
    return null;
  }

  const trimmed = String(notes).trim();
  return trimmed || null;
}

function normalizeChainLabel(chainLabel) {
  if (chainLabel === undefined || chainLabel === null) {
    return null;
  }

  const trimmed = String(chainLabel).trim();
  return trimmed || null;
}

function aliasLookupKey(alias) {
  return normalizeAlias(alias)?.toLowerCase() ?? null;
}

function normalizeContactRecord(address, record) {
  const normalizedAddress = getAddress(address).toLowerCase();

  return {
    address: normalizedAddress,
    alias: normalizeAlias(record.alias),
    notes: normalizeNotes(record.notes),
    chainLabel: normalizeChainLabel(record.chainLabel),
    verified: Boolean(record.verified),
    verifiedAt: record.verifiedAt ?? null,
    fingerprint: record.fingerprint ?? null,
    lastMatchedAt: record.lastMatchedAt ?? null,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeContactsState(contacts, chainId, walletAddress) {
  const normalizedWalletAddress = getAddress(walletAddress).toLowerCase();
  const nextState = {
    schemaVersion: CONTACTS_SCHEMA_VERSION,
    chainId: String(chainId),
    walletAddress: normalizedWalletAddress,
    contacts: {}
  };

  for (const [address, record] of Object.entries(contacts?.contacts ?? {})) {
    nextState.contacts[getAddress(address).toLowerCase()] = normalizeContactRecord(address, record);
  }

  return nextState;
}

function assertAliasAvailable(contacts, address, alias) {
  const nextAliasKey = aliasLookupKey(alias);
  if (!nextAliasKey) {
    return;
  }

  for (const [contactAddress, contact] of Object.entries(contacts?.contacts ?? {})) {
    if (contactAddress === address) {
      continue;
    }

    if (aliasLookupKey(contact.alias) === nextAliasKey) {
      throw new Error(`Alias "${alias}" is already assigned to ${contactAddress}.`);
    }
  }
}

export function getContactsPath({ chainId, walletAddress, baseDir }) {
  return path.join(getWalletStateDir({ chainId, walletAddress, baseDir }), "contacts.json");
}

export async function readContacts({ chainId, walletAddress, baseDir }) {
  try {
    const filePath = getContactsPath({ chainId, walletAddress, baseDir });
    const contents = await readFile(filePath, "utf8");
    return normalizeContactsState(JSON.parse(contents), chainId, walletAddress);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeContacts({ chainId, walletAddress, contacts, baseDir }) {
  const filePath = getContactsPath({ chainId, walletAddress, baseDir });
  const nextState = normalizeContactsState(contacts, chainId, walletAddress);

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);

  return filePath;
}

export function getContact(contacts, reference) {
  if (!contacts) {
    return null;
  }

  if (!reference) {
    return null;
  }

  if (isAddress(reference)) {
    return contacts.contacts?.[getAddress(reference).toLowerCase()] ?? null;
  }

  const aliasKey = aliasLookupKey(reference);
  if (!aliasKey) {
    return null;
  }

  return Object.values(contacts.contacts ?? {}).find((contact) => aliasLookupKey(contact.alias) === aliasKey) ?? null;
}

export function listContacts(contacts) {
  return Object.values(contacts?.contacts ?? {}).sort((left, right) => {
    const leftLabel = (left.alias ?? left.address).toLowerCase();
    const rightLabel = (right.alias ?? right.address).toLowerCase();
    return leftLabel.localeCompare(rightLabel);
  });
}

export function upsertContact({
  contacts,
  chainId,
  walletAddress,
  address,
  alias,
  notes,
  chainLabel,
  verified,
  verifiedAt,
  fingerprint,
  lastMatchedAt
}) {
  const nextState = normalizeContactsState(contacts, chainId, walletAddress);
  const normalizedAddress = getAddress(address).toLowerCase();
  const existing = nextState.contacts[normalizedAddress];
  const nextAlias = alias !== undefined ? normalizeAlias(alias) : existing?.alias ?? null;

  assertAliasAvailable(nextState, normalizedAddress, nextAlias);

  nextState.contacts[normalizedAddress] = normalizeContactRecord(normalizedAddress, {
    ...existing,
    alias: nextAlias,
    notes: notes !== undefined ? normalizeNotes(notes) : existing?.notes ?? null,
    chainLabel: chainLabel !== undefined ? normalizeChainLabel(chainLabel) : existing?.chainLabel ?? null,
    verified: verified ?? existing?.verified ?? false,
    verifiedAt: verifiedAt !== undefined ? verifiedAt : existing?.verifiedAt ?? null,
    fingerprint: fingerprint !== undefined ? fingerprint : existing?.fingerprint ?? null,
    lastMatchedAt: lastMatchedAt !== undefined ? lastMatchedAt : existing?.lastMatchedAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString()
  });

  return nextState;
}

export function importContactsState({ contacts, importedContacts, chainId, walletAddress }) {
  let nextState = normalizeContactsState(contacts, chainId, walletAddress);
  for (const contact of listContacts(importedContacts)) {
    nextState = upsertContact({
      contacts: nextState,
      chainId,
      walletAddress,
      address: contact.address,
      alias: contact.alias,
      notes: contact.notes,
      chainLabel: contact.chainLabel,
      verified: contact.verified,
      verifiedAt: contact.verifiedAt,
      fingerprint: contact.fingerprint,
      lastMatchedAt: contact.lastMatchedAt
    });
  }

  return nextState;
}

export async function readImportedContacts({ filePath }) {
  const contents = await readFile(filePath, "utf8");
  const parsed = JSON.parse(contents);

  if (!parsed || typeof parsed !== "object" || typeof parsed.contacts !== "object") {
    throw new Error("Invalid contact export file.");
  }

  return {
    schemaVersion: CONTACTS_SCHEMA_VERSION,
    chainId: String(parsed.chainId ?? "unknown"),
    walletAddress: parsed.walletAddress ?? "0x0000000000000000000000000000000000000000",
    contacts: parsed.contacts
  };
}

export function resolveContactAddress({ contacts, reference, label = "address or alias" }) {
  if (!reference) {
    throw new Error(`Missing ${label}.`);
  }

  if (isAddress(reference)) {
    return getAddress(reference);
  }

  const contact = getContact(contacts, reference);
  if (!contact) {
    throw new Error(`Unknown ${label}: ${reference}`);
  }

  return getAddress(contact.address);
}

export function formatContactLabel(contacts, address) {
  const normalizedAddress = getAddress(address).toLowerCase();
  const contact = contacts?.contacts?.[normalizedAddress];
  if (!contact?.alias) {
    return shortAddress(normalizedAddress);
  }

  return `${contact.alias} (${shortAddress(normalizedAddress)})`;
}

export function formatChatKeyFingerprint(pubKeyHex) {
  const normalized = String(pubKeyHex ?? "").replace(/^0x/, "").toUpperCase();
  if (!normalized || /^0+$/.test(normalized)) {
    return "unknown";
  }

  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

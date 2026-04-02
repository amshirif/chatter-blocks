import { randomBytes } from "node:crypto";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { bytesToHex, encodePacked, getAddress, keccak256 } from "viem";

import { decryptPackedJsonHex, encryptPackedJsonHex } from "./crypto.js";
import { getWalletStateDir, getLocalKey } from "./keyring.js";
import {
  decryptJsonObject,
  defaultPassphrase,
  encryptJsonObject,
  isEncryptedSecretEnvelope
} from "./secret-store.js";

export const DEFAULT_INVITE_TTL_HOURS = 24;
export const MIN_INVITE_TTL_HOURS = 1;
export const MAX_INVITE_TTL_HOURS = 24 * 7;
export const INVITE_STATUS_LABELS = ["NONE", "ACTIVE", "MATCHED", "CANCELLED", "EXPIRED"];
export const RESPONSE_STATUS_LABELS = ["NONE", "ACTIVE", "ACCEPTED"];

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeInviteRecord(record) {
  return {
    inviteId: String(record.inviteId),
    role: record.role ?? null,
    inviteSecret: record.inviteSecret ?? null,
    phraseA: record.phraseA ?? null,
    phraseB: record.phraseB ?? null,
    inviteCommitment: record.inviteCommitment ?? null,
    posterWalletAddress: record.posterWalletAddress ? getAddress(record.posterWalletAddress).toLowerCase() : null,
    posterKeyVersion: record.posterKeyVersion ?? null,
    expiresAt: record.expiresAt ?? null,
    status: record.status ?? "ACTIVE",
    peerWalletAddress: record.peerWalletAddress ? getAddress(record.peerWalletAddress).toLowerCase() : null,
    peerKeyVersion: record.peerKeyVersion ?? null,
    matchedAt: record.matchedAt ?? null,
    acceptedResponseId: record.acceptedResponseId ?? null,
    responses: normalizeResponseMap(record.responses),
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeResponseMap(responses) {
  const nextResponses = {};

  for (const [responseId, response] of Object.entries(responses ?? {})) {
    nextResponses[String(responseId)] = {
      responseId: String(response.responseId ?? responseId),
      responderWalletAddress: response.responderWalletAddress
        ? getAddress(response.responderWalletAddress).toLowerCase()
        : null,
      responderKeyVersion: response.responderKeyVersion ?? null,
      submittedAt: response.submittedAt ?? null,
      status: response.status ?? "ACTIVE",
      decrypted: Boolean(response.decrypted),
      commitmentMatches: response.commitmentMatches ?? null,
      metadataMatches: response.metadataMatches ?? null,
      createdAt: response.createdAt ?? null,
      validationError: response.validationError ?? null,
      updatedAt: new Date().toISOString()
    };
  }

  return nextResponses;
}

function getInviteRecord(hubState, inviteId) {
  return hubState?.invites?.[String(inviteId)] ?? null;
}

function getResponseRecord(hubState, inviteId, responseId) {
  return getInviteRecord(hubState, inviteId)?.responses?.[String(responseId)] ?? null;
}

export function getHubPath({ chainId, walletAddress, baseDir }) {
  return path.join(getWalletStateDir({ chainId, walletAddress, baseDir }), "hub.json");
}

export function normalizePhrase(phrase) {
  if (typeof phrase !== "string") {
    throw new Error("Phrase must be a string.");
  }

  const normalized = phrase.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Phrase cannot be empty after trimming.");
  }

  return normalized;
}

export function deriveInviteCommitment({ inviteSecret, phraseA, phraseB }) {
  return keccak256(
    encodePacked(
      ["bytes32", "string", "string"],
      [inviteSecret, normalizePhrase(phraseA), normalizePhrase(phraseB)]
    )
  );
}

export function generateInviteSecret() {
  return bytesToHex(randomBytes(32));
}

export function resolveInviteTtlSeconds(rawHours) {
  const ttlHours = rawHours === undefined ? DEFAULT_INVITE_TTL_HOURS : Number(rawHours);
  if (!Number.isInteger(ttlHours) || ttlHours < MIN_INVITE_TTL_HOURS || ttlHours > MAX_INVITE_TTL_HOURS) {
    throw new Error(
      `TTL must be an integer number of hours between ${MIN_INVITE_TTL_HOURS} and ${MAX_INVITE_TTL_HOURS}.`
    );
  }

  return ttlHours * 60 * 60;
}

export function inviteStatusLabel(status) {
  if (typeof status === "string") {
    if (!INVITE_STATUS_LABELS.includes(status)) {
      throw new Error(`Unknown invite status: ${status}`);
    }

    return status;
  }

  return INVITE_STATUS_LABELS[Number(status)] ?? "UNKNOWN";
}

export function responseStatusLabel(status) {
  if (typeof status === "string") {
    if (!RESPONSE_STATUS_LABELS.includes(status)) {
      throw new Error(`Unknown response status: ${status}`);
    }

    return status;
  }

  return RESPONSE_STATUS_LABELS[Number(status)] ?? "UNKNOWN";
}

function normalizeHubState(hubState, chainId, walletAddress) {
  const normalizedAddress = getAddress(walletAddress).toLowerCase();
  const nextState = {
    schemaVersion: 2,
    chainId: String(chainId),
    walletAddress: normalizedAddress,
    invites: {}
  };

  for (const [inviteId, invite] of Object.entries(hubState?.invites ?? {})) {
    nextState.invites[String(inviteId)] = normalizeInviteRecord({
      inviteId,
      ...invite
    });
  }

  return nextState;
}

export async function readHubState({
  chainId,
  walletAddress,
  baseDir,
  passphrase = defaultPassphrase()
}) {
  try {
    const filePath = getHubPath({ chainId, walletAddress, baseDir });
    const contents = await readFile(filePath, "utf8");
    const parsed = JSON.parse(contents);
    if (!isEncryptedSecretEnvelope(parsed)) {
      return normalizeHubState(parsed, chainId, walletAddress);
    }

    if (!passphrase) {
      throw new Error(
        "Hub state is encrypted. Set CHATTER_PASSPHRASE or pass --passphrase to unlock invite secrets."
      );
    }

    return normalizeHubState(decryptJsonObject(parsed, passphrase), chainId, walletAddress);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeHubState({
  chainId,
  walletAddress,
  hubState,
  baseDir,
  passphrase = defaultPassphrase()
}) {
  const filePath = getHubPath({ chainId, walletAddress, baseDir });
  const nextHubState = normalizeHubState(hubState, chainId, walletAddress);
  const payload = passphrase ? encryptJsonObject(nextHubState, passphrase) : nextHubState;

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

export function upsertHubInviteRecord({
  hubState,
  chainId,
  walletAddress,
  inviteId,
  role,
  inviteSecret,
  phraseA,
  phraseB,
  inviteCommitment,
  posterWalletAddress,
  posterKeyVersion,
  expiresAt,
  status,
  peerWalletAddress,
  peerKeyVersion,
  matchedAt,
  acceptedResponseId
}) {
  const nextHubState = normalizeHubState(hubState, chainId, walletAddress);
  const inviteKey = String(inviteId);
  const existing = getInviteRecord(nextHubState, inviteKey);

  nextHubState.invites[inviteKey] = normalizeInviteRecord({
    ...existing,
    inviteId: inviteKey,
    role: role ?? existing?.role ?? null,
    inviteSecret: inviteSecret ?? existing?.inviteSecret ?? null,
    phraseA: phraseA ?? existing?.phraseA ?? null,
    phraseB: phraseB ?? existing?.phraseB ?? null,
    inviteCommitment: inviteCommitment ?? existing?.inviteCommitment ?? null,
    posterWalletAddress: posterWalletAddress ?? existing?.posterWalletAddress ?? null,
    posterKeyVersion:
      posterKeyVersion !== undefined && posterKeyVersion !== null
        ? Number(posterKeyVersion)
        : existing?.posterKeyVersion ?? null,
    expiresAt: expiresAt !== undefined && expiresAt !== null ? Number(expiresAt) : existing?.expiresAt ?? null,
    status: inviteStatusLabel(status ?? existing?.status ?? "ACTIVE"),
    peerWalletAddress: peerWalletAddress ?? existing?.peerWalletAddress ?? null,
    peerKeyVersion:
      peerKeyVersion !== undefined && peerKeyVersion !== null
        ? Number(peerKeyVersion)
        : existing?.peerKeyVersion ?? null,
    matchedAt: matchedAt !== undefined && matchedAt !== null ? Number(matchedAt) : existing?.matchedAt ?? null,
    acceptedResponseId:
      acceptedResponseId !== undefined && acceptedResponseId !== null
        ? String(acceptedResponseId)
        : existing?.acceptedResponseId ?? null,
    responses: existing?.responses ?? {}
  });

  return nextHubState;
}

export function upsertHubResponseRecord({
  hubState,
  chainId,
  walletAddress,
  inviteId,
  responseId,
  responderWalletAddress,
  responderKeyVersion,
  submittedAt,
  status,
  decrypted,
  commitmentMatches,
  metadataMatches,
  createdAt,
  validationError
}) {
  const nextHubState = normalizeHubState(hubState, chainId, walletAddress);
  const inviteKey = String(inviteId);

  nextHubState.invites[inviteKey] = normalizeInviteRecord({
    ...(nextHubState.invites[inviteKey] ?? { inviteId: inviteKey }),
    inviteId: inviteKey
  });

  const responseKey = String(responseId);
  const existing = getResponseRecord(nextHubState, inviteKey, responseKey);

  nextHubState.invites[inviteKey].responses[responseKey] = {
    responseId: responseKey,
    responderWalletAddress: responderWalletAddress
      ? getAddress(responderWalletAddress).toLowerCase()
      : existing?.responderWalletAddress ?? null,
    responderKeyVersion:
      responderKeyVersion !== undefined && responderKeyVersion !== null
        ? Number(responderKeyVersion)
        : existing?.responderKeyVersion ?? null,
    submittedAt:
      submittedAt !== undefined && submittedAt !== null
        ? Number(submittedAt)
        : existing?.submittedAt ?? null,
    status: responseStatusLabel(status ?? existing?.status ?? "ACTIVE"),
    decrypted: decrypted ?? existing?.decrypted ?? false,
    commitmentMatches:
      commitmentMatches !== undefined ? Boolean(commitmentMatches) : existing?.commitmentMatches ?? null,
    metadataMatches:
      metadataMatches !== undefined ? Boolean(metadataMatches) : existing?.metadataMatches ?? null,
    createdAt:
      createdAt !== undefined && createdAt !== null
        ? Number(createdAt)
        : existing?.createdAt ?? null,
    validationError: validationError ?? existing?.validationError ?? null,
    updatedAt: new Date().toISOString()
  };

  return nextHubState;
}

export function getStoredInvite(hubState, inviteId) {
  return getInviteRecord(hubState, inviteId);
}

export function getStoredResponse(hubState, inviteId, responseId) {
  return getResponseRecord(hubState, inviteId, responseId);
}

export function listStoredMatches(hubState) {
  return Object.values(hubState?.invites ?? {})
    .filter((record) => record.status === "MATCHED" && record.peerWalletAddress)
    .sort((left, right) => Number(left.inviteId) - Number(right.inviteId));
}

export function extractMatchPeer({ viewerAddress, inviteMatch }) {
  const viewer = getAddress(viewerAddress).toLowerCase();
  const poster = getAddress(inviteMatch.poster).toLowerCase();
  const responder = getAddress(inviteMatch.responder).toLowerCase();

  if (viewer === poster) {
    return {
      role: "poster",
      peerWalletAddress: responder,
      peerKeyVersion: Number(inviteMatch.responderKeyVersion)
    };
  }

  if (viewer === responder) {
    return {
      role: "responder",
      peerWalletAddress: poster,
      peerKeyVersion: Number(inviteMatch.posterKeyVersion)
    };
  }

  throw new Error("Viewer is not part of this invite match.");
}

export function createInviteResponseEnvelope({ inviteCommitment, responderWallet, responderKeyVersion }) {
  return {
    v: 1,
    inviteCommitment,
    responderWallet: getAddress(responderWallet).toLowerCase(),
    responderKeyVersion: Number(responderKeyVersion),
    createdAt: Date.now()
  };
}

export function encryptInviteResponseEnvelope({
  inviteCommitment,
  responderWallet,
  responderKeyVersion,
  responderSecretKey,
  posterPublicKey,
  nonceBytes
}) {
  const envelope = createInviteResponseEnvelope({
    inviteCommitment,
    responderWallet,
    responderKeyVersion
  });

  return {
    envelope,
    ...encryptPackedJsonHex({
      payload: envelope,
      senderSecretKey: responderSecretKey,
      recipientPublicKey: posterPublicKey,
      nonceBytes
    })
  };
}

export function decryptInviteResponseEnvelope({
  ciphertextHex,
  posterSecretKey,
  responderPublicKeyHex
}) {
  const parsed = decryptPackedJsonHex({
    ciphertextHex,
    viewerSecretKey: posterSecretKey,
    peerPublicKeyHex: responderPublicKeyHex
  });

  if (
    !parsed ||
    parsed?.v !== 1 ||
    typeof parsed.inviteCommitment !== "string" ||
    typeof parsed.responderWallet !== "string" ||
    typeof parsed.responderKeyVersion !== "number" ||
    typeof parsed.createdAt !== "number"
  ) {
    return null;
  }

  try {
    return {
      ...parsed,
      responderWallet: getAddress(parsed.responderWallet).toLowerCase()
    };
  } catch {
    return null;
  }
}

export function validateInviteResponseEnvelope({
  envelope,
  inviteCommitment,
  responseHeader
}) {
  const expectedCommitment = inviteCommitment.toLowerCase();
  const expectedResponder = getAddress(responseHeader.responder).toLowerCase();
  const expectedKeyVersion = Number(responseHeader.responderKeyVersion);
  const errors = [];

  if (!envelope) {
    errors.push("unable to decrypt");
  } else {
    if (envelope.inviteCommitment.toLowerCase() !== expectedCommitment) {
      errors.push("invite commitment mismatch");
    }
    if (envelope.responderWallet !== expectedResponder) {
      errors.push("responder wallet mismatch");
    }
    if (Number(envelope.responderKeyVersion) !== expectedKeyVersion) {
      errors.push("responder key version mismatch");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    commitmentMatches: envelope ? envelope.inviteCommitment.toLowerCase() === expectedCommitment : false,
    metadataMatches:
      envelope
        ? envelope.responderWallet === expectedResponder &&
          Number(envelope.responderKeyVersion) === expectedKeyVersion
        : false
  };
}

export function decryptAndValidateInviteResponse({
  invite,
  responseHeader,
  ciphertextHex,
  keyring,
  responderPublicKeyHex,
  inviteCommitment
}) {
  const posterLocalKey = getLocalKey(keyring, Number(invite.posterKeyVersion));
  if (!posterLocalKey) {
    return {
      decrypted: false,
      envelope: null,
      valid: false,
      errors: [
        `missing local key version ${invite.posterKeyVersion.toString()}; restore a prior secret backup to validate this response`
      ],
      commitmentMatches: false,
      metadataMatches: false
    };
  }

  if (!responderPublicKeyHex || /^0x0+$/.test(responderPublicKeyHex)) {
    return {
      decrypted: false,
      envelope: null,
      valid: false,
      errors: [`missing responder key version ${responseHeader.responderKeyVersion.toString()}`],
      commitmentMatches: false,
      metadataMatches: false
    };
  }

  const envelope = decryptInviteResponseEnvelope({
    ciphertextHex,
    posterSecretKey: posterLocalKey.secretKey,
    responderPublicKeyHex
  });
  const validation = validateInviteResponseEnvelope({
    envelope,
    inviteCommitment,
    responseHeader
  });

  return {
    decrypted: envelope !== null,
    envelope,
    ...validation
  };
}

export function formatInviteSummary({ inviteId, invite, nowMs = Date.now() }) {
  const postedAtMs = Number(invite.postedAt) * 1000;
  const expiresAtMs = Number(invite.expiresAt) * 1000;
  const ageMinutes = Math.max(0, Math.floor((nowMs - postedAtMs) / 60000));

  return [
    `#${inviteId.toString()}`,
    inviteStatusLabel(invite.status),
    `poster=${shortAddress(invite.poster)}`,
    `age=${ageMinutes}m`,
    `expires=${new Date(expiresAtMs).toISOString()}`
  ].join(" ");
}

export function formatInviteResponseRecord({ responseId, header, validation }) {
  const status = responseStatusLabel(header.status);
  const validity = validation.valid ? "valid" : "invalid";
  const reason = validation.valid ? "" : ` ${validation.errors.join(", ")}`;

  return [
    `#${responseId.toString()}`,
    status,
    `responder=${shortAddress(header.responder)}`,
    validity + reason
  ].join(" ");
}

export function formatStoredMatch(record) {
  const matchedAt = record.matchedAt
    ? new Date(Number(record.matchedAt) * 1000).toISOString()
    : "unknown";

  return [
    `#${record.inviteId}`,
    record.role,
    `peer=${shortAddress(record.peerWalletAddress)}`,
    `peerKeyVersion=${record.peerKeyVersion}`,
    `matched=${matchedAt}`
  ].join(" ");
}

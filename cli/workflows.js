import { Buffer } from "node:buffer";

import { bytesToHex, getAddress, hexToBytes } from "viem";

import { createConnections, createPublicConnection, resolveCursor, resolveLimit } from "./config.js";
import { encryptEnvelope } from "./crypto.js";
import {
  acceptInviteResponse,
  cancelInvite,
  getActiveChatKey,
  getChatKeyHistory,
  getConversationId,
  getConversationPage,
  getInboxPage,
  getInvite,
  getInviteMatchesByAccount,
  getInvitePage,
  getInviteResponse,
  getInviteResponseCiphertext,
  getInviteResponsePage,
  getMatchRecord,
  postInvite,
  registerChatKey,
  sendEncryptedMessage,
  submitInviteResponse
} from "./contract.js";
import {
  decryptAndValidateInviteResponse,
  deriveInviteCommitment,
  encryptInviteResponseEnvelope,
  extractMatchPeer,
  generateInviteSecret,
  getStoredInvite,
  getStoredResponse,
  readHubState,
  resolveInviteTtlSeconds,
  upsertHubInviteRecord,
  upsertHubResponseRecord,
  writeHubState
} from "./hub.js";
import { hydrateMessages } from "./messages.js";
import {
  createChatKeypair,
  getActiveLocalKey,
  localKeyMatchesOnChain,
  readKeyring,
  upsertKeyMaterial,
  writeKeyring
} from "./keyring.js";
import {
  formatChatKeyFingerprint,
  getContact,
  listContacts,
  readContacts,
  resolveContactAddress,
  upsertContact,
  writeContacts
} from "./contacts.js";
import { createTimingReport } from "./timing.js";

export const INVITE_STATUS_ACTIVE = 1;
export const MAX_LIST_SCAN_LIMIT = 100;

export function resolveId(rawValue, label) {
  try {
    const value = BigInt(rawValue);
    if (value < 0n) {
      throw new Error("negative id");
    }

    return value;
  } catch {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export function encodeInviteShareCode({ inviteId, inviteSecret, phraseA, phraseB }) {
  return Buffer.from(
    JSON.stringify({
      inviteId: String(inviteId),
      inviteSecret,
      phraseA,
      phraseB
    }),
    "utf8"
  ).toString("base64url");
}

export function decodeInviteShareCode(shareCode) {
  try {
    const parsed = JSON.parse(Buffer.from(String(shareCode), "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.inviteId !== "string" ||
      typeof parsed.inviteSecret !== "string" ||
      typeof parsed.phraseA !== "string" ||
      typeof parsed.phraseB !== "string"
    ) {
      throw new Error("invalid shape");
    }

    return parsed;
  } catch {
    throw new Error("Invalid share bundle code.");
  }
}

export async function loadKeyringOrThrow({ chainId, walletAddress }) {
  const keyring = await readKeyring({ chainId, walletAddress });
  if (!keyring) {
    throw new Error("Missing local chat keyring. Run `pnpm chat setup` first.");
  }

  return keyring;
}

export async function loadActiveLocalKeyOrThrow({ publicClient, contractAddress, chainId, walletAddress }) {
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress });
  const localKey = getActiveLocalKey(keyring);
  if (!localKey) {
    throw new Error("Missing active local chat key. Run `pnpm chat setup` first.");
  }

  const onChainKey = await getActiveChatKey(publicClient, contractAddress, walletAddress);
  if (!localKeyMatchesOnChain({
    keyring,
    onChainVersion: onChainKey.version,
    onChainPubKey: onChainKey.pubKey
  })) {
    throw new Error("Local active chat key does not match the on-chain active key. Run `pnpm chat setup --rotate`.");
  }

  return { keyring, localKey, onChainKey };
}

export async function collectActiveInviteEntries({ publicClient, contractAddress, cursor, limit }) {
  const entries = [];
  const batchSize = Math.min(Math.max(limit * 2, 20), MAX_LIST_SCAN_LIMIT);
  let nextPageCursor = cursor;
  let nextCursor = null;

  while (entries.length < limit) {
    const inviteIds = await getInvitePage(publicClient, contractAddress, nextPageCursor, batchSize);
    if (inviteIds.length === 0) {
      break;
    }

    const invites = await Promise.all(
      inviteIds.map(async (inviteId) => ({
        inviteId,
        invite: await getInvite(publicClient, contractAddress, inviteId)
      }))
    );

    for (const entry of invites) {
      if (entry.invite.status !== INVITE_STATUS_ACTIVE) {
        continue;
      }

      entries.push(entry);
      if (entries.length === limit) {
        nextCursor = entry.inviteId;
        return { entries, nextCursor };
      }
    }

    if (inviteIds.length < batchSize) {
      break;
    }

    nextPageCursor = inviteIds[inviteIds.length - 1];
  }

  return { entries, nextCursor };
}

export async function collectInviteResponseIds({ publicClient, contractAddress, inviteId }) {
  const responseIds = [];
  let cursor = 0n;

  for (;;) {
    const page = await getInviteResponsePage(publicClient, contractAddress, inviteId, cursor, MAX_LIST_SCAN_LIMIT);
    if (page.length === 0) {
      break;
    }

    responseIds.push(...page);
    if (page.length < MAX_LIST_SCAN_LIMIT) {
      break;
    }

    cursor = page[page.length - 1];
  }

  return responseIds;
}

export async function inspectInviteResponse({
  publicClient,
  contractAddress,
  invite,
  inviteId,
  responseId,
  keyring,
  inviteCommitment
}) {
  const responseHeader = await getInviteResponse(publicClient, contractAddress, responseId);
  const ciphertextHex = await getInviteResponseCiphertext(
    publicClient,
    contractAddress,
    responseId,
    responseHeader.blockNumber
  );
  const responderPublicKeyHex = await getChatKeyHistory(
    publicClient,
    contractAddress,
    responseHeader.responder,
    responseHeader.responderKeyVersion
  );
  const validation = decryptAndValidateInviteResponse({
    invite,
    responseHeader,
    ciphertextHex,
    keyring,
    responderPublicKeyHex,
    inviteCommitment
  });

  if (responseHeader.inviteId !== inviteId) {
    throw new Error(
      `Invite response ${responseId.toString()} belongs to invite ${responseHeader.inviteId.toString()}, not ${inviteId.toString()}.`
    );
  }

  return {
    responseHeader,
    ciphertextHex,
    validation
  };
}

async function upsertMatchedContact({
  publicClient,
  contractAddress,
  chainId,
  walletAddress,
  peerWalletAddress,
  peerKeyVersion,
  matchedAt
}) {
  const currentContacts = await readContacts({ chainId, walletAddress });
  const peerPubKey = await getChatKeyHistory(
    publicClient,
    contractAddress,
    peerWalletAddress,
    peerKeyVersion
  );
  const nextContacts = upsertContact({
    contacts: currentContacts,
    chainId,
    walletAddress,
    address: peerWalletAddress,
    fingerprint: formatChatKeyFingerprint(peerPubKey),
    lastMatchedAt: Number(matchedAt),
    verified: currentContacts ? Boolean(getContact(currentContacts, peerWalletAddress)?.verified) : false
  });
  const contactsPath = await writeContacts({
    chainId,
    walletAddress,
    contacts: nextContacts
  });

  return {
    contacts: nextContacts,
    contactsPath,
    fingerprint: formatChatKeyFingerprint(peerPubKey)
  };
}

export function resolveSetupStrategy({ rotate = false, keyring, onChainKey }) {
  const localKey = getActiveLocalKey(keyring);

  if (rotate) {
    return {
      action: "create-new-key",
      localKey: null
    };
  }

  if (keyring && onChainKey.version > 0n && localKeyMatchesOnChain({
    keyring,
    onChainVersion: onChainKey.version,
    onChainPubKey: onChainKey.pubKey
  })) {
    return {
      action: "already-configured",
      localKey
    };
  }

  if (onChainKey.version === 0n && localKey) {
    return {
      action: "reuse-local-key",
      localKey
    };
  }

  if (onChainKey.version === 0n) {
    return {
      action: "create-new-key",
      localKey: null
    };
  }

  return {
    action: "rotation-required",
    localKey,
    message: "Existing on-chain chat key does not match local key material. Run `pnpm chat setup --rotate` or `pnpm chat start --rotate` to replace it."
  };
}

export async function setupChatWorkflow(options, { rotate = false } = {}) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const onChainKey = await getActiveChatKey(publicClient, contractAddress, walletAddress);
  const keyring = await readKeyring({ chainId, walletAddress });
  const strategy = resolveSetupStrategy({ rotate, keyring, onChainKey });

  if (strategy.action === "already-configured") {
    return {
      alreadyConfigured: true,
      walletAddress,
      chainId,
      contractAddress,
      onChainKey
    };
  }

  if (strategy.action === "rotation-required") {
    throw new Error(strategy.message);
  }

  const keyPair = strategy.action === "reuse-local-key"
    ? {
      publicKey: strategy.localKey.publicKey,
      secretKey: strategy.localKey.secretKey
    }
    : createChatKeypair();
  const registration = await registerChatKey(
    publicClient,
    walletClient,
    contractAddress,
    bytesToHex(keyPair.publicKey)
  );
  const nextKeyring = upsertKeyMaterial({
    keyring,
    chainId,
    walletAddress,
    version: Number(registration.version),
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey
  });
  const keyringPath = await writeKeyring({
    chainId,
    walletAddress,
    keyring: nextKeyring
  });

  return {
    alreadyConfigured: false,
    reusedLocalKey: strategy.action === "reuse-local-key",
    walletAddress,
    chainId,
    contractAddress,
    registration,
    keyringPath
  };
}

export async function sendMessageWorkflow(options, { recipientReference, message }) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const senderAddress = getAddress(account.address);
  const contacts = await readContacts({ chainId, walletAddress: senderAddress });
  const recipientAddress = resolveContactAddress({
    contacts,
    reference: recipientReference,
    label: "recipient address or alias"
  });
  const { localKey } = await loadActiveLocalKeyOrThrow({
    publicClient,
    contractAddress,
    chainId,
    walletAddress: senderAddress
  });

  const recipientOnChainKey = await getActiveChatKey(publicClient, contractAddress, recipientAddress);
  if (recipientOnChainKey.version === 0n) {
    throw new Error(`Recipient ${recipientAddress} has not registered a chat key.`);
  }

  const encrypted = encryptEnvelope({
    text: message,
    senderSecretKey: localKey.secretKey,
    recipientPublicKey: hexToBytes(recipientOnChainKey.pubKey)
  });
  const sentMessage = await sendEncryptedMessage(
    publicClient,
    walletClient,
    contractAddress,
    recipientAddress,
    encrypted.nonceHex,
    encrypted.ciphertextHex
  );

  const nextContacts = upsertContact({
    contacts,
    chainId,
    walletAddress: senderAddress,
    address: recipientAddress,
    fingerprint: formatChatKeyFingerprint(recipientOnChainKey.pubKey)
  });
  const contactsPath = await writeContacts({
    chainId,
    walletAddress: senderAddress,
    contacts: nextContacts
  });

  return {
    sentMessage,
    senderAddress,
    recipientAddress,
    contacts: nextContacts,
    contactsPath
  };
}

export async function postInviteWorkflow(options, { phraseA, phraseB, ttlHours }) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const { onChainKey } = await loadActiveLocalKeyOrThrow({
    publicClient,
    contractAddress,
    chainId,
    walletAddress
  });

  const inviteSecret = generateInviteSecret();
  const inviteCommitment = deriveInviteCommitment({
    inviteSecret,
    phraseA,
    phraseB
  });
  const ttlSeconds = resolveInviteTtlSeconds(ttlHours);
  const postedInvite = await postInvite(
    publicClient,
    walletClient,
    contractAddress,
    inviteCommitment,
    ttlSeconds
  );
  const inviteDetails = await getInvite(publicClient, contractAddress, postedInvite.inviteId);
  const nextHubState = upsertHubInviteRecord({
    hubState: await readHubState({ chainId, walletAddress }),
    chainId,
    walletAddress,
    inviteId: postedInvite.inviteId,
    role: "poster",
    inviteSecret,
    phraseA,
    phraseB,
    inviteCommitment,
    posterWalletAddress: walletAddress,
    posterKeyVersion: onChainKey.version,
    expiresAt: inviteDetails.expiresAt,
    status: inviteDetails.status
  });
  const hubPath = await writeHubState({
    chainId,
    walletAddress,
    hubState: nextHubState
  });
  const shareCode = encodeInviteShareCode({
    inviteId: postedInvite.inviteId,
    inviteSecret,
    phraseA,
    phraseB
  });

  return {
    postedInvite,
    inviteDetails,
    walletAddress,
    chainId,
    contractAddress,
    hubPath,
    inviteSecret,
    inviteCommitment,
    shareCode
  };
}

export async function listActiveInvitesWorkflow(options, { cursor, limit }, { connections = null } = {}) {
  const resolvedConnections = connections ?? await createPublicConnection(options);
  const { publicClient, contractAddress } = resolvedConnections;
  const resolvedCursor = resolveCursor(cursor);
  const resolvedLimit = resolveLimit(limit);

  return collectActiveInviteEntries({
    publicClient,
    contractAddress,
    cursor: resolvedCursor,
    limit: resolvedLimit
  });
}

export async function respondInviteWorkflow(options, { inviteId, phraseA, phraseB, inviteSecret }) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const { localKey, onChainKey } = await loadActiveLocalKeyOrThrow({
    publicClient,
    contractAddress,
    chainId,
    walletAddress
  });

  const resolvedInviteId = BigInt(inviteId);
  const inviteDetails = await getInvite(publicClient, contractAddress, resolvedInviteId);
  const inviteCommitment = deriveInviteCommitment({
    inviteSecret,
    phraseA,
    phraseB
  });

  if (inviteCommitment.toLowerCase() !== inviteDetails.inviteCommitment.toLowerCase()) {
    throw new Error("Shared secret or phrases do not match the posted invite commitment.");
  }

  const posterPublicKeyHex = await getChatKeyHistory(
    publicClient,
    contractAddress,
    inviteDetails.poster,
    inviteDetails.posterKeyVersion
  );
  if (!posterPublicKeyHex || /^0x0+$/.test(posterPublicKeyHex)) {
    throw new Error(
      `Poster chat key version ${inviteDetails.posterKeyVersion.toString()} is not available on-chain.`
    );
  }

  const { ciphertextHex } = encryptInviteResponseEnvelope({
    inviteCommitment,
    responderWallet: walletAddress,
    responderKeyVersion: onChainKey.version,
    responderSecretKey: localKey.secretKey,
    posterPublicKey: hexToBytes(posterPublicKeyHex)
  });

  const submittedResponse = await submitInviteResponse(
    publicClient,
    walletClient,
    contractAddress,
    resolvedInviteId,
    ciphertextHex
  );
  const responseHeader = await getInviteResponse(publicClient, contractAddress, submittedResponse.responseId);
  let nextHubState = upsertHubInviteRecord({
    hubState: await readHubState({ chainId, walletAddress }),
    chainId,
    walletAddress,
    inviteId: resolvedInviteId,
    role: "responder",
    inviteSecret,
    phraseA,
    phraseB,
    inviteCommitment,
    posterWalletAddress: inviteDetails.poster,
    posterKeyVersion: inviteDetails.posterKeyVersion,
    expiresAt: inviteDetails.expiresAt,
    status: inviteDetails.status
  });
  nextHubState = upsertHubResponseRecord({
    hubState: nextHubState,
    chainId,
    walletAddress,
    inviteId: resolvedInviteId,
    responseId: submittedResponse.responseId,
    responderWalletAddress: walletAddress,
    responderKeyVersion: responseHeader.responderKeyVersion,
    submittedAt: responseHeader.submittedAt,
    status: responseHeader.status
  });
  await writeHubState({
    chainId,
    walletAddress,
    hubState: nextHubState
  });

  return {
    submittedResponse,
    responseHeader,
    inviteDetails,
    inviteCommitment,
    walletAddress
  };
}

export async function reviewInviteResponsesWorkflow(options, { inviteId }) {
  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress });
  const resolvedInviteId = BigInt(inviteId);
  const invite = await getInvite(publicClient, contractAddress, resolvedInviteId);

  if (invite.poster.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`Invite ${resolvedInviteId.toString()} was posted by ${invite.poster}, not ${walletAddress}.`);
  }

  let hubState = await readHubState({ chainId, walletAddress });
  const storedInvite = getStoredInvite(hubState, resolvedInviteId);
  if (!storedInvite?.inviteCommitment) {
    throw new Error("Missing local invite record with an invite commitment. Run `pnpm chat hub post` from this wallet.");
  }
  if (storedInvite.inviteCommitment.toLowerCase() !== invite.inviteCommitment.toLowerCase()) {
    throw new Error("Local invite record does not match the on-chain invite commitment.");
  }

  hubState = upsertHubInviteRecord({
    hubState,
    chainId,
    walletAddress,
    inviteId: resolvedInviteId,
    role: "poster",
    inviteSecret: storedInvite.inviteSecret,
    phraseA: storedInvite.phraseA,
    phraseB: storedInvite.phraseB,
    inviteCommitment: storedInvite.inviteCommitment,
    posterWalletAddress: invite.poster,
    posterKeyVersion: invite.posterKeyVersion,
    expiresAt: invite.expiresAt,
    status: invite.status,
    peerWalletAddress: storedInvite.peerWalletAddress,
    peerKeyVersion: storedInvite.peerKeyVersion,
    matchedAt: storedInvite.matchedAt,
    acceptedResponseId: storedInvite.acceptedResponseId
  });

  const responseIds = await collectInviteResponseIds({ publicClient, contractAddress, inviteId: resolvedInviteId });
  const responses = [];

  for (const responseId of responseIds) {
    const { responseHeader, validation } = await inspectInviteResponse({
      publicClient,
      contractAddress,
      invite,
      inviteId: resolvedInviteId,
      responseId,
      keyring,
      inviteCommitment: storedInvite.inviteCommitment
    });

    hubState = upsertHubResponseRecord({
      hubState,
      chainId,
      walletAddress,
      inviteId: resolvedInviteId,
      responseId,
      responderWalletAddress: responseHeader.responder,
      responderKeyVersion: responseHeader.responderKeyVersion,
      submittedAt: responseHeader.submittedAt,
      status: responseHeader.status,
      decrypted: validation.decrypted,
      commitmentMatches: validation.commitmentMatches,
      metadataMatches: validation.metadataMatches,
      createdAt: validation.envelope?.createdAt ?? getStoredResponse(hubState, resolvedInviteId, responseId)?.createdAt,
      validationError: validation.valid ? null : validation.errors.join(", ")
    });

    responses.push({
      responseId,
      header: responseHeader,
      validation
    });
  }

  await writeHubState({
    chainId,
    walletAddress,
    hubState
  });

  return {
    invite,
    responses,
    walletAddress
  };
}

export async function acceptInviteResponseWorkflow(options, { inviteId, responseId }) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress });
  const resolvedInviteId = BigInt(inviteId);
  const resolvedResponseId = BigInt(responseId);
  const invite = await getInvite(publicClient, contractAddress, resolvedInviteId);

  if (invite.poster.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`Invite ${resolvedInviteId.toString()} was posted by ${invite.poster}, not ${walletAddress}.`);
  }

  let hubState = await readHubState({ chainId, walletAddress });
  const storedInvite = getStoredInvite(hubState, resolvedInviteId);
  if (!storedInvite?.inviteCommitment) {
    throw new Error("Missing local invite record with an invite commitment. Run `pnpm chat hub post` from this wallet.");
  }
  if (storedInvite.inviteCommitment.toLowerCase() !== invite.inviteCommitment.toLowerCase()) {
    throw new Error("Local invite record does not match the on-chain invite commitment.");
  }

  const { responseHeader, validation } = await inspectInviteResponse({
    publicClient,
    contractAddress,
    invite,
    inviteId: resolvedInviteId,
    responseId: resolvedResponseId,
    keyring,
    inviteCommitment: storedInvite.inviteCommitment
  });

  if (!validation.valid) {
    throw new Error(`Invite response ${resolvedResponseId.toString()} is invalid: ${validation.errors.join(", ")}.`);
  }

  const acceptedMatch = await acceptInviteResponse(
    publicClient,
    walletClient,
    contractAddress,
    resolvedInviteId,
    resolvedResponseId
  );
  const matchRecord = await getMatchRecord(publicClient, contractAddress, resolvedInviteId);

  hubState = upsertHubInviteRecord({
    hubState,
    chainId,
    walletAddress,
    inviteId: resolvedInviteId,
    role: "poster",
    inviteSecret: storedInvite.inviteSecret,
    phraseA: storedInvite.phraseA,
    phraseB: storedInvite.phraseB,
    inviteCommitment: storedInvite.inviteCommitment,
    posterWalletAddress: invite.poster,
    posterKeyVersion: invite.posterKeyVersion,
    expiresAt: invite.expiresAt,
    status: "MATCHED",
    peerWalletAddress: acceptedMatch.responder,
    peerKeyVersion: matchRecord.responderKeyVersion,
    matchedAt: matchRecord.matchedAt,
    acceptedResponseId: matchRecord.acceptedResponseId
  });
  hubState = upsertHubResponseRecord({
    hubState,
    chainId,
    walletAddress,
    inviteId: resolvedInviteId,
    responseId: resolvedResponseId,
    responderWalletAddress: responseHeader.responder,
    responderKeyVersion: responseHeader.responderKeyVersion,
    submittedAt: responseHeader.submittedAt,
    status: "ACCEPTED",
    decrypted: true,
    commitmentMatches: validation.commitmentMatches,
    metadataMatches: validation.metadataMatches,
    createdAt: validation.envelope?.createdAt ?? getStoredResponse(hubState, resolvedInviteId, resolvedResponseId)?.createdAt,
    validationError: null
  });
  await writeHubState({
    chainId,
    walletAddress,
    hubState
  });

  const contactUpdate = await upsertMatchedContact({
    publicClient,
    contractAddress,
    chainId,
    walletAddress,
    peerWalletAddress: acceptedMatch.responder,
    peerKeyVersion: matchRecord.responderKeyVersion,
    matchedAt: matchRecord.matchedAt
  });

  return {
    acceptedMatch,
    matchRecord,
    contactUpdate
  };
}

function inviteRecordNeedsMatchSync(storedInvite, { peer, invite, matchRecord }) {
  if (!storedInvite) {
    return true;
  }

  return (
    storedInvite.role !== peer.role ||
    storedInvite.inviteCommitment?.toLowerCase() !== invite.inviteCommitment.toLowerCase() ||
    storedInvite.posterWalletAddress?.toLowerCase() !== invite.poster.toLowerCase() ||
    Number(storedInvite.posterKeyVersion) !== Number(invite.posterKeyVersion) ||
    Number(storedInvite.expiresAt) !== Number(invite.expiresAt) ||
    storedInvite.status !== "MATCHED" ||
    storedInvite.peerWalletAddress?.toLowerCase() !== peer.peerWalletAddress.toLowerCase() ||
    Number(storedInvite.peerKeyVersion) !== Number(peer.peerKeyVersion) ||
    Number(storedInvite.matchedAt) !== Number(matchRecord.matchedAt) ||
    String(storedInvite.acceptedResponseId ?? "") !== String(matchRecord.acceptedResponseId ?? "")
  );
}

function contactNeedsMatchSync(existingContact, { fingerprint, matchedAt }) {
  if (!existingContact) {
    return true;
  }

  return (
    existingContact.fingerprint !== fingerprint ||
    Number(existingContact.lastMatchedAt) !== Number(matchedAt)
  );
}

export async function listInviteMatchesWorkflow(options, context = {}) {
  const timing = createTimingReport("wf.listInviteMatches");
  const {
    connections = null,
    hubState: initialHubState = undefined,
    contacts: initialContacts = undefined
  } = context;
  const { publicClient, account, chainId, contractAddress } = connections ?? await createConnections(options);
  const walletAddress = getAddress(account.address);
  const matchEvents = await timing.measure(
    "events",
    async () => await getInviteMatchesByAccount(publicClient, contractAddress, walletAddress)
  );
  let hubState = initialHubState ?? await readHubState({ chainId, walletAddress });
  let contacts = initialContacts ?? await readContacts({ chainId, walletAddress });
  let hubStateChanged = false;
  let contactsChanged = false;
  const chatKeyHistoryCache = new Map();

  const loadPeerKeyFingerprint = async (peerWalletAddress, peerKeyVersion) => {
    const cacheKey = `${peerWalletAddress.toLowerCase()}:${peerKeyVersion.toString()}`;
    if (!chatKeyHistoryCache.has(cacheKey)) {
      chatKeyHistoryCache.set(
        cacheKey,
        getChatKeyHistory(publicClient, contractAddress, peerWalletAddress, peerKeyVersion)
          .then((pubKey) => formatChatKeyFingerprint(pubKey))
      );
    }

    return await chatKeyHistoryCache.get(cacheKey);
  };

  const matchEntries = await timing.measure(
    "batchReads",
    async () => await Promise.all(
      matchEvents.map(async (inviteMatch) => {
        const peer = extractMatchPeer({ viewerAddress: walletAddress, inviteMatch });
        const [matchRecord, invite, fingerprint] = await Promise.all([
          getMatchRecord(publicClient, contractAddress, inviteMatch.inviteId),
          getInvite(publicClient, contractAddress, inviteMatch.inviteId),
          loadPeerKeyFingerprint(peer.peerWalletAddress, peer.peerKeyVersion)
        ]);

        return {
          inviteId: inviteMatch.inviteId,
          peer,
          matchRecord,
          invite,
          fingerprint
        };
      })
    )
  );

  for (const entry of matchEntries) {
    const storedInvite = getStoredInvite(hubState, entry.inviteId);

    if (inviteRecordNeedsMatchSync(storedInvite, entry)) {
      hubState = upsertHubInviteRecord({
        hubState,
        chainId,
        walletAddress,
        inviteId: entry.inviteId,
        role: entry.peer.role,
        inviteSecret: storedInvite?.inviteSecret,
        phraseA: storedInvite?.phraseA,
        phraseB: storedInvite?.phraseB,
        inviteCommitment: storedInvite?.inviteCommitment ?? entry.invite.inviteCommitment,
        posterWalletAddress: entry.invite.poster,
        posterKeyVersion: entry.invite.posterKeyVersion,
        expiresAt: entry.invite.expiresAt,
        status: "MATCHED",
        peerWalletAddress: entry.peer.peerWalletAddress,
        peerKeyVersion: entry.peer.peerKeyVersion,
        matchedAt: entry.matchRecord.matchedAt,
        acceptedResponseId: entry.matchRecord.acceptedResponseId
      });
      hubStateChanged = true;
    }

    const storedAcceptedResponse = storedInvite?.responses?.[String(entry.matchRecord.acceptedResponseId)];
    if (storedAcceptedResponse && storedAcceptedResponse.status !== "ACCEPTED") {
      hubState = upsertHubResponseRecord({
        hubState,
        chainId,
        walletAddress,
        inviteId: entry.inviteId,
        responseId: entry.matchRecord.acceptedResponseId,
        status: "ACCEPTED"
      });
      hubStateChanged = true;
    }

    const existingContact = getContact(contacts, entry.peer.peerWalletAddress);
    if (contactNeedsMatchSync(existingContact, {
      fingerprint: entry.fingerprint,
      matchedAt: Number(entry.matchRecord.matchedAt)
    })) {
      contacts = upsertContact({
        contacts,
        chainId,
        walletAddress,
        address: entry.peer.peerWalletAddress,
        fingerprint: entry.fingerprint,
        lastMatchedAt: Number(entry.matchRecord.matchedAt)
      });
      contactsChanged = true;
    }
  }

  if (hubStateChanged) {
    await writeHubState({
      chainId,
      walletAddress,
      hubState
    });
  }
  const contactsPath = contactsChanged
    ? await writeContacts({ chainId, walletAddress, contacts })
    : null;

  const result = {
    walletAddress,
    matches: matchEntries.map(({ fingerprint, ...entry }) => entry),
    hubState,
    contacts,
    contactsPath
  };
  timing.flush();
  return result;
}

export async function cancelInviteWorkflow(options, { inviteId }) {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const resolvedInviteId = BigInt(inviteId);
  const cancelledInvite = await cancelInvite(publicClient, walletClient, contractAddress, resolvedInviteId);
  const hubState = await readHubState({ chainId, walletAddress });

  if (hubState) {
    const nextHubState = upsertHubInviteRecord({
      hubState,
      chainId,
      walletAddress,
      inviteId: resolvedInviteId,
      role: getStoredInvite(hubState, resolvedInviteId)?.role ?? "poster",
      status: "CANCELLED"
    });
    await writeHubState({
      chainId,
      walletAddress,
      hubState: nextHubState
    });
  }

  return { cancelledInvite };
}

export async function readInboxWorkflow(options, { peerReference = null, cursor, limit, connections = null, keyring = null, contacts = null }) {
  const timing = createTimingReport("wf.readInbox");
  const { publicClient, account, chainId, contractAddress } = connections ?? await createConnections(options);
  const viewerAddress = getAddress(account.address);
  const resolvedKeyring = keyring ?? await loadKeyringOrThrow({ chainId, walletAddress: viewerAddress });
  const resolvedContacts = contacts ?? await readContacts({ chainId, walletAddress: viewerAddress });
  const resolvedLimit = resolveLimit(limit);
  const resolvedCursor = resolveCursor(cursor);
  const peerAddress = peerReference
    ? resolveContactAddress({ contacts: resolvedContacts, reference: peerReference, label: "conversation address or alias" })
    : null;

  let messageIds;
  let conversationId = null;
  if (peerAddress) {
    conversationId = await getConversationId(publicClient, contractAddress, viewerAddress, peerAddress);
    messageIds = await getConversationPage(publicClient, contractAddress, conversationId, resolvedCursor, resolvedLimit);
  } else {
    messageIds = await getInboxPage(publicClient, contractAddress, viewerAddress, resolvedCursor, resolvedLimit);
  }

  const records = messageIds.length === 0
    ? []
    : await hydrateMessages({
      publicClient,
      contractAddress,
      viewerAddress,
      keyring: resolvedKeyring,
      messageIds,
      timingReport: timing
    });

  const result = {
    viewerAddress,
    peerAddress,
    conversationId,
    records,
    limit: resolvedLimit,
    nextCursor: messageIds.length === resolvedLimit ? messageIds[messageIds.length - 1] : null,
    contacts: resolvedContacts
  };
  timing.flush();
  return result;
}

export async function listContactsWorkflow(options) {
  const { account, chainId } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const contacts = await readContacts({ chainId, walletAddress });

  return {
    walletAddress,
    chainId,
    contacts,
    list: listContacts(contacts)
  };
}

export async function saveContactWorkflow(options, { address, alias, notes, chainLabel }) {
  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const normalizedAddress = getAddress(address);
  const contacts = await readContacts({ chainId, walletAddress });
  const activeChatKey = await getActiveChatKey(publicClient, contractAddress, normalizedAddress);
  const fingerprint = activeChatKey.version > 0n
    ? formatChatKeyFingerprint(activeChatKey.pubKey)
    : null;
  const nextContacts = upsertContact({
    contacts,
    chainId,
    walletAddress,
    address: normalizedAddress,
    alias,
    notes,
    chainLabel,
    fingerprint
  });
  const contactsPath = await writeContacts({
    chainId,
    walletAddress,
    contacts: nextContacts
  });

  return {
    contact: getContact(nextContacts, normalizedAddress),
    contactsPath
  };
}

export async function showContactWorkflow(options, { reference, connections = null, contacts = null }) {
  const { publicClient, account, chainId, contractAddress } = connections ?? await createConnections(options);
  const walletAddress = getAddress(account.address);
  const resolvedContacts = contacts ?? await readContacts({ chainId, walletAddress });
  const peerAddress = resolveContactAddress({ contacts: resolvedContacts, reference, label: "contact address or alias" });
  const contact = getContact(resolvedContacts, peerAddress);
  const activeChatKey = await getActiveChatKey(publicClient, contractAddress, peerAddress);

  return {
    contact,
    peerAddress,
    activeChatKey,
    fingerprint: activeChatKey.version > 0n ? formatChatKeyFingerprint(activeChatKey.pubKey) : "unknown"
  };
}

export async function verifyContactWorkflow(options, { reference }) {
  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const contacts = await readContacts({ chainId, walletAddress });
  const peerAddress = resolveContactAddress({ contacts, reference, label: "contact address or alias" });
  const activeChatKey = await getActiveChatKey(publicClient, contractAddress, peerAddress);
  if (activeChatKey.version === 0n) {
    throw new Error(`Contact ${peerAddress} has no registered chat key.`);
  }

  const nextContacts = upsertContact({
    contacts,
    chainId,
    walletAddress,
    address: peerAddress,
    verified: true,
    verifiedAt: new Date().toISOString(),
    fingerprint: formatChatKeyFingerprint(activeChatKey.pubKey)
  });
  const contactsPath = await writeContacts({
    chainId,
    walletAddress,
    contacts: nextContacts
  });

  return {
    contact: getContact(nextContacts, peerAddress),
    activeChatKey,
    contactsPath
  };
}

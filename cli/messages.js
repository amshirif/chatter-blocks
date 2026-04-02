import { getAddress } from "viem";

import { decryptEnvelopeHex } from "./crypto.js";
import { getChatKeyHistory, getMessageCiphertext, getMessageHeader } from "./contract.js";
import { getLocalKey } from "./keyring.js";

export function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sortByMessageIdAscending(records) {
  return [...records].sort((left, right) => {
    if (left.messageId === right.messageId) {
      return 0;
    }

    return left.messageId < right.messageId ? -1 : 1;
  });
}

export function mergeConversationRecords(existingRecords, newRecords) {
  const merged = new Map();

  for (const record of [...existingRecords, ...newRecords]) {
    merged.set(record.messageId.toString(), record);
  }

  return sortByMessageIdAscending([...merged.values()]);
}

export async function decryptMessageRecord({
  header,
  ciphertextHex,
  viewerAddress,
  keyring,
  resolveChatKey
}) {
  const viewer = getAddress(viewerAddress);
  const incoming = header.recipient.toLowerCase() === viewer.toLowerCase();
  const outgoing = header.sender.toLowerCase() === viewer.toLowerCase();

  if (!incoming && !outgoing) {
    return {
      direction: "other",
      decrypted: false,
      message: "[viewer is not part of this message]"
    };
  }

  const localVersion = incoming ? header.recipientKeyVersion : header.senderKeyVersion;
  const peerAccount = incoming ? header.sender : header.recipient;
  const peerVersion = incoming ? header.senderKeyVersion : header.recipientKeyVersion;
  const localKey = getLocalKey(keyring, Number(localVersion));

  if (!localKey) {
    return {
      direction: incoming ? "in" : "out",
      decrypted: false,
      message: `[missing local key version ${localVersion.toString()}]`
    };
  }

  const peerPublicKeyHex = await resolveChatKey(peerAccount, peerVersion);
  if (!peerPublicKeyHex || /^0x0+$/.test(peerPublicKeyHex)) {
    return {
      direction: incoming ? "in" : "out",
      decrypted: false,
      message: `[missing peer key version ${peerVersion.toString()}]`
    };
  }

  const envelope = decryptEnvelopeHex({
    nonceHex: header.nonce,
    ciphertextHex,
    viewerSecretKey: localKey.secretKey,
    peerPublicKeyHex
  });

  if (!envelope) {
    return {
      direction: incoming ? "in" : "out",
      decrypted: false,
      message: "[unable to decrypt]"
    };
  }

  return {
    direction: incoming ? "in" : "out",
    decrypted: true,
    text: envelope.text,
    createdAt: envelope.createdAt
  };
}

export async function hydrateMessages({
  publicClient,
  contractAddress,
  viewerAddress,
  keyring,
  messageIds,
  timingReport = null
}) {
  const keyCache = new Map();

  const resolveChatKey = async (account, version) => {
    const cacheKey = `${account.toLowerCase()}:${version.toString()}`;
    if (!keyCache.has(cacheKey)) {
      keyCache.set(cacheKey, getChatKeyHistory(publicClient, contractAddress, account, version));
    }

    return keyCache.get(cacheKey);
  };

  const messageParts = await (timingReport
    ? timingReport.measure("headersAndCiphertexts", async () => await Promise.all(
      messageIds.map(async (messageId) => {
        const header = await getMessageHeader(publicClient, contractAddress, messageId);
        const ciphertextHex = await getMessageCiphertext(
          publicClient,
          contractAddress,
          messageId,
          header.blockNumber
        );

        return {
          messageId: BigInt(messageId),
          header,
          ciphertextHex
        };
      })
    ))
    : Promise.all(
      messageIds.map(async (messageId) => {
        const header = await getMessageHeader(publicClient, contractAddress, messageId);
        const ciphertextHex = await getMessageCiphertext(
          publicClient,
          contractAddress,
          messageId,
          header.blockNumber
        );

        return {
          messageId: BigInt(messageId),
          header,
          ciphertextHex
        };
      })
    ));

  const records = await (timingReport
    ? timingReport.measure("hydrate", async () => await Promise.all(
      messageParts.map(async ({ messageId, header, ciphertextHex }) => {
        const decrypted = await decryptMessageRecord({
          header,
          ciphertextHex,
          viewerAddress,
          keyring,
          resolveChatKey
        });

        return {
          messageId,
          header,
          ciphertextHex,
          ...decrypted
        };
      })
    ))
    : Promise.all(
      messageParts.map(async ({ messageId, header, ciphertextHex }) => {
        const decrypted = await decryptMessageRecord({
          header,
          ciphertextHex,
          viewerAddress,
          keyring,
          resolveChatKey
        });

        return {
          messageId,
          header,
          ciphertextHex,
          ...decrypted
        };
      })
    ));

  return sortByMessageIdAscending(records);
}

export function formatMessageRecord(record) {
  const timestamp = record.createdAt
    ? new Date(record.createdAt).toISOString()
    : new Date(Number(record.header.sentAt) * 1000).toISOString();
  const label = record.direction === "out" ? "you" : shortAddress(record.header.sender);
  const body = record.decrypted ? record.text : record.message;

  return `[${timestamp}] ${label}: ${body}`;
}

export function addSeenIds(seenIds, messageIds) {
  for (const messageId of messageIds) {
    seenIds.add(messageId.toString());
  }
}

export async function collectNewMessageIds({ fetchPage, seenIds, pageSize }) {
  const unseen = [];
  let cursor = 0n;

  for (;;) {
    const page = await fetchPage(cursor);
    if (page.length === 0) {
      break;
    }

    let foundSeen = false;
    for (const messageId of page) {
      if (seenIds.has(messageId.toString())) {
        foundSeen = true;
        break;
      }

      unseen.push(BigInt(messageId));
    }

    if (foundSeen || page.length < pageSize) {
      break;
    }

    cursor = page[page.length - 1];
  }

  return unseen.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

import { decodeEventLog, getAddress } from "viem";

import { chatterBlocksAbi } from "./abi.js";

const inviteMatchedEventAbi = chatterBlocksAbi.find(
  (item) => item.type === "event" && item.name === "InviteMatched"
);

function normalizeChatKeyState(result) {
  if (Array.isArray(result)) {
    return {
      version: BigInt(result[0]),
      pubKey: result[1]
    };
  }

  return {
    version: BigInt(result.version),
    pubKey: result.pubKey
  };
}

function normalizeMessageHeader(result) {
  if (Array.isArray(result)) {
    const [
      conversationId,
      sender,
      recipient,
      sentAt,
      blockNumber,
      senderKeyVersion,
      recipientKeyVersion,
      nonce,
      ciphertextHash
    ] = result;

    return {
      conversationId,
      sender: getAddress(sender),
      recipient: getAddress(recipient),
      sentAt: BigInt(sentAt),
      blockNumber: BigInt(blockNumber),
      senderKeyVersion: BigInt(senderKeyVersion),
      recipientKeyVersion: BigInt(recipientKeyVersion),
      nonce,
      ciphertextHash
    };
  }

  return {
    conversationId: result.conversationId,
    sender: getAddress(result.sender),
    recipient: getAddress(result.recipient),
    sentAt: BigInt(result.sentAt),
    blockNumber: BigInt(result.blockNumber),
    senderKeyVersion: BigInt(result.senderKeyVersion),
    recipientKeyVersion: BigInt(result.recipientKeyVersion),
    nonce: result.nonce,
    ciphertextHash: result.ciphertextHash
  };
}

function normalizeInvite(result) {
  if (Array.isArray(result)) {
    const [poster, postedAt, expiresAt, posterKeyVersion, inviteCommitment, status] = result;

    return {
      poster: getAddress(poster),
      postedAt: BigInt(postedAt),
      expiresAt: BigInt(expiresAt),
      posterKeyVersion: BigInt(posterKeyVersion),
      inviteCommitment,
      status: Number(status)
    };
  }

  return {
    poster: getAddress(result.poster),
    postedAt: BigInt(result.postedAt),
    expiresAt: BigInt(result.expiresAt),
    posterKeyVersion: BigInt(result.posterKeyVersion),
    inviteCommitment: result.inviteCommitment,
    status: Number(result.status)
  };
}

function normalizeInviteResponse(result) {
  if (Array.isArray(result)) {
    const [inviteId, responder, submittedAt, blockNumber, responderKeyVersion, ciphertextHash, status] = result;

    return {
      inviteId: BigInt(inviteId),
      responder: getAddress(responder),
      submittedAt: BigInt(submittedAt),
      blockNumber: BigInt(blockNumber),
      responderKeyVersion: BigInt(responderKeyVersion),
      ciphertextHash,
      status: Number(status)
    };
  }

  return {
    inviteId: BigInt(result.inviteId),
    responder: getAddress(result.responder),
    submittedAt: BigInt(result.submittedAt),
    blockNumber: BigInt(result.blockNumber),
    responderKeyVersion: BigInt(result.responderKeyVersion),
    ciphertextHash: result.ciphertextHash,
    status: Number(result.status)
  };
}

function normalizeMatchRecord(result) {
  if (Array.isArray(result)) {
    const [responder, matchedAt, posterKeyVersion, responderKeyVersion, acceptedResponseId] = result;

    return {
      responder: getAddress(responder),
      matchedAt: BigInt(matchedAt),
      posterKeyVersion: BigInt(posterKeyVersion),
      responderKeyVersion: BigInt(responderKeyVersion),
      acceptedResponseId: BigInt(acceptedResponseId)
    };
  }

  return {
    responder: getAddress(result.responder),
    matchedAt: BigInt(result.matchedAt),
    posterKeyVersion: BigInt(result.posterKeyVersion),
    responderKeyVersion: BigInt(result.responderKeyVersion),
    acceptedResponseId: BigInt(result.acceptedResponseId)
  };
}

function decodeLog(log) {
  try {
    return decodeEventLog({
      abi: chatterBlocksAbi,
      data: log.data,
      topics: log.topics
    });
  } catch {
    return null;
  }
}

function findEvent(logs, eventName) {
  for (const log of logs) {
    const decoded = decodeLog(log);
    if (decoded?.eventName === eventName) {
      return decoded.args;
    }
  }

  throw new Error(`Missing ${eventName} event in transaction receipt.`);
}

export async function getActiveChatKey(publicClient, contractAddress, account) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "activeChatKeys",
    args: [getAddress(account)]
  });

  return normalizeChatKeyState(result);
}

export async function getChatKeyHistory(publicClient, contractAddress, account, version) {
  return publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "chatKeyHistory",
    args: [getAddress(account), BigInt(version)]
  });
}

export async function getInvite(publicClient, contractAddress, inviteId) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getInvite",
    args: [BigInt(inviteId)]
  });

  return normalizeInvite(result);
}

export async function getInviteResponse(publicClient, contractAddress, responseId) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getInviteResponse",
    args: [BigInt(responseId)]
  });

  return normalizeInviteResponse(result);
}

export async function getMatchRecord(publicClient, contractAddress, inviteId) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getMatchRecord",
    args: [BigInt(inviteId)]
  });

  return normalizeMatchRecord(result);
}

export async function getMessageHeader(publicClient, contractAddress, messageId) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "messageHeaders",
    args: [BigInt(messageId)]
  });

  return normalizeMessageHeader(result);
}

export async function getInboxPage(publicClient, contractAddress, account, cursor, limit) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getInboxPage",
    args: [getAddress(account), BigInt(cursor), BigInt(limit)]
  });

  return result.map((value) => BigInt(value));
}

export async function getInvitePage(publicClient, contractAddress, cursor, limit) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getInvitePage",
    args: [BigInt(cursor), BigInt(limit)]
  });

  return result.map((value) => BigInt(value));
}

export async function getInviteResponsePage(publicClient, contractAddress, inviteId, cursor, limit) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getInviteResponsePage",
    args: [BigInt(inviteId), BigInt(cursor), BigInt(limit)]
  });

  return result.map((value) => BigInt(value));
}

export async function getConversationPage(publicClient, contractAddress, conversationId, cursor, limit) {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "getConversationPage",
    args: [conversationId, BigInt(cursor), BigInt(limit)]
  });

  return result.map((value) => BigInt(value));
}

export async function getConversationId(publicClient, contractAddress, accountA, accountB) {
  return publicClient.readContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "conversationIdOf",
    args: [getAddress(accountA), getAddress(accountB)]
  });
}

export async function registerChatKey(publicClient, walletClient, contractAddress, pubKeyHex) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "registerChatKey",
    args: [pubKeyHex]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "ChatKeyRegistered");

  return {
    hash,
    receipt,
    version: BigInt(eventArgs.version),
    pubKey: eventArgs.pubKey
  };
}

export async function postInvite(publicClient, walletClient, contractAddress, inviteCommitment, ttlSeconds) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "postInvite",
    args: [inviteCommitment, ttlSeconds]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "InvitePosted");

  return {
    hash,
    receipt,
    inviteId: BigInt(eventArgs.inviteId),
    poster: getAddress(eventArgs.poster),
    expiresAt: BigInt(eventArgs.expiresAt),
    posterKeyVersion: BigInt(eventArgs.posterKeyVersion)
  };
}

export async function submitInviteResponse(
  publicClient,
  walletClient,
  contractAddress,
  inviteId,
  ciphertextHex
) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "submitInviteResponse",
    args: [BigInt(inviteId), ciphertextHex]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "InviteResponseSubmitted");

  return {
    hash,
    receipt,
    inviteId: BigInt(eventArgs.inviteId),
    responseId: BigInt(eventArgs.responseId),
    responder: getAddress(eventArgs.responder),
    responderKeyVersion: BigInt(eventArgs.responderKeyVersion)
  };
}

export async function acceptInviteResponse(
  publicClient,
  walletClient,
  contractAddress,
  inviteId,
  responseId
) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "acceptInviteResponse",
    args: [BigInt(inviteId), BigInt(responseId)]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "InviteMatched");

  return {
    hash,
    receipt,
    inviteId: BigInt(eventArgs.inviteId),
    poster: getAddress(eventArgs.poster),
    responder: getAddress(eventArgs.responder),
    posterKeyVersion: BigInt(eventArgs.posterKeyVersion),
    responderKeyVersion: BigInt(eventArgs.responderKeyVersion)
  };
}

export async function cancelInvite(publicClient, walletClient, contractAddress, inviteId) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "cancelInvite",
    args: [BigInt(inviteId)]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "InviteCancelled");

  return {
    hash,
    receipt,
    inviteId: BigInt(eventArgs.inviteId),
    poster: getAddress(eventArgs.poster)
  };
}

export async function sendEncryptedMessage(
  publicClient,
  walletClient,
  contractAddress,
  recipient,
  nonceHex,
  ciphertextHex
) {
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: chatterBlocksAbi,
    functionName: "sendMessage",
    args: [getAddress(recipient), nonceHex, ciphertextHex]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const eventArgs = findEvent(receipt.logs, "MessageSent");

  return {
    hash,
    receipt,
    conversationId: eventArgs.conversationId,
    messageId: BigInt(eventArgs.messageId)
  };
}

export async function getMessageCiphertext(publicClient, contractAddress, messageId, blockNumber) {
  const logs = await publicClient.getLogs({
    address: contractAddress,
    fromBlock: BigInt(blockNumber),
    toBlock: BigInt(blockNumber)
  });

  for (const log of logs) {
    const decoded = decodeLog(log);
    if (decoded?.eventName === "MessageSent" && BigInt(decoded.args.messageId) === BigInt(messageId)) {
      return decoded.args.ciphertext;
    }
  }

  throw new Error(`Unable to find ciphertext for message ${messageId.toString()}.`);
}

export async function getInviteResponseCiphertext(publicClient, contractAddress, responseId, blockNumber) {
  const logs = await publicClient.getLogs({
    address: contractAddress,
    fromBlock: BigInt(blockNumber),
    toBlock: BigInt(blockNumber)
  });

  for (const log of logs) {
    const decoded = decodeLog(log);
    if (
      decoded?.eventName === "InviteResponseSubmitted" &&
      BigInt(decoded.args.responseId) === BigInt(responseId)
    ) {
      return decoded.args.ciphertext;
    }
  }

  throw new Error(`Unable to find ciphertext for invite response ${responseId.toString()}.`);
}

export async function getInviteMatchesByAccount(publicClient, contractAddress, account) {
  const normalizedAccount = getAddress(account);
  const [posterLogs, responderLogs] = await Promise.all([
    publicClient.getLogs({
      address: contractAddress,
      event: inviteMatchedEventAbi,
      args: { poster: normalizedAccount },
      fromBlock: 0n
    }),
    publicClient.getLogs({
      address: contractAddress,
      event: inviteMatchedEventAbi,
      args: { responder: normalizedAccount },
      fromBlock: 0n
    })
  ]);

  return [...posterLogs, ...responderLogs]
    .map((log) => ({
      inviteId: BigInt(log.args.inviteId),
      poster: getAddress(log.args.poster),
      responder: getAddress(log.args.responder),
      posterKeyVersion: BigInt(log.args.posterKeyVersion),
      responderKeyVersion: BigInt(log.args.responderKeyVersion),
      blockNumber: BigInt(log.blockNumber),
      logIndex: Number(log.logIndex)
    }))
    .sort((left, right) => {
      if (left.blockNumber === right.blockNumber) {
        return left.logIndex - right.logIndex;
      }

      return left.blockNumber < right.blockNumber ? -1 : 1;
    });
}

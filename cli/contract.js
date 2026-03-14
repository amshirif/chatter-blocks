import { decodeEventLog, getAddress } from "viem";

import { chatterBlocksAbi } from "./abi.js";

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

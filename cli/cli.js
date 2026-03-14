#!/usr/bin/env node

import { Command } from "commander";
import { bytesToHex, getAddress, hexToBytes } from "viem";

import { createConnections, resolveCursor, resolveLimit } from "./config.js";
import { encryptEnvelope } from "./crypto.js";
import {
  getActiveChatKey,
  getConversationId,
  getConversationPage,
  getInboxPage,
  registerChatKey,
  sendEncryptedMessage
} from "./contract.js";
import {
  addSeenIds,
  collectNewMessageIds,
  formatMessageRecord,
  hydrateMessages
} from "./messages.js";
import {
  createChatKeypair,
  getActiveLocalKey,
  localKeyMatchesOnChain,
  readKeyring,
  upsertKeyMaterial,
  writeKeyring
} from "./keyring.js";

function addSharedOptions(command) {
  return command
    .option("--rpc-url <url>", "RPC URL (overrides CHATTER_RPC_URL)")
    .option(
      "--contract-address <address>",
      "deployed ChatterBlocks contract address (overrides CHATTER_CONTRACT_ADDRESS)"
    )
    .option("--private-key <hex>", "wallet private key (overrides CHATTER_PRIVATE_KEY)");
}

function printRecords(records) {
  for (const record of records) {
    console.log(formatMessageRecord(record));
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadKeyringOrThrow({ chainId, walletAddress }) {
  const keyring = await readKeyring({ chainId, walletAddress });
  if (!keyring) {
    throw new Error("Missing local chat keyring. Run `pnpm chat setup` first.");
  }

  return keyring;
}

const program = new Command();
program.name("chat").description("Send and read end-to-end encrypted blockchain messages.");
program.showHelpAfterError();

addSharedOptions(
  program
    .command("setup")
    .description("Generate a local chat keypair and register the public key on-chain.")
    .option("--rotate", "rotate an existing chat key")
).action(async (options) => {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const onChainKey = await getActiveChatKey(publicClient, contractAddress, walletAddress);
  const keyring = await readKeyring({ chainId, walletAddress });

  if (!options.rotate) {
    if (keyring && onChainKey.version > 0n && localKeyMatchesOnChain({
      keyring,
      onChainVersion: onChainKey.version,
      onChainPubKey: onChainKey.pubKey
    })) {
      console.log(`Chat key already configured for ${walletAddress} on chain ${chainId}.`);
      return;
    }

    if (keyring || onChainKey.version > 0n) {
      throw new Error("Chat key already exists or is out of sync. Re-run with --rotate to replace it.");
    }
  }

  const keyPair = createChatKeypair();
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

  console.log(`Registered chat key version ${registration.version.toString()} for ${walletAddress}.`);
  console.log(`Contract: ${contractAddress}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Keyring: ${keyringPath}`);
  console.log(`Transaction: ${registration.hash}`);
});

addSharedOptions(
  program
    .command("send")
    .description("Encrypt a message for a recipient and send it on-chain.")
    .requiredOption("--to <address>", "recipient wallet address")
    .requiredOption("--message <text>", "message text")
).action(async (options) => {
  const { publicClient, walletClient, account, chainId, contractAddress } = await createConnections(options);
  const senderAddress = getAddress(account.address);
  const recipientAddress = getAddress(options.to);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress: senderAddress });
  const localKey = getActiveLocalKey(keyring);

  if (!localKey) {
    throw new Error("Missing active local chat key. Run `pnpm chat setup` first.");
  }

  const senderOnChainKey = await getActiveChatKey(publicClient, contractAddress, senderAddress);
  if (!localKeyMatchesOnChain({
    keyring,
    onChainVersion: senderOnChainKey.version,
    onChainPubKey: senderOnChainKey.pubKey
  })) {
    throw new Error("Local active chat key does not match the on-chain active key. Run `pnpm chat setup --rotate`.");
  }

  const recipientOnChainKey = await getActiveChatKey(publicClient, contractAddress, recipientAddress);
  if (recipientOnChainKey.version === 0n) {
    throw new Error(`Recipient ${recipientAddress} has not registered a chat key.`);
  }

  const encrypted = encryptEnvelope({
    text: options.message,
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

  console.log(`Sent message ${sentMessage.messageId.toString()} to ${recipientAddress}.`);
  console.log(`Conversation: ${sentMessage.conversationId}`);
  console.log(`Transaction: ${sentMessage.hash}`);
});

addSharedOptions(
  program
    .command("inbox")
    .description("Read and decrypt messages for the current wallet.")
    .option("--with <address>", "show a full conversation with a specific peer")
    .option("--cursor <messageId>", "page older messages starting before this message ID")
    .option("--limit <count>", "page size (default: 20)")
    .option("--follow", "poll every 2 seconds for new messages")
).action(async (options) => {
  if (options.follow && options.cursor !== undefined) {
    throw new Error("--follow cannot be combined with --cursor.");
  }

  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const viewerAddress = getAddress(account.address);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress: viewerAddress });
  const limit = resolveLimit(options.limit);
  const initialCursor = resolveCursor(options.cursor);
  const peerAddress = options.with ? getAddress(options.with) : null;

  let fetchPage;
  if (peerAddress) {
    const conversationId = await getConversationId(publicClient, contractAddress, viewerAddress, peerAddress);
    fetchPage = (cursor) =>
      getConversationPage(publicClient, contractAddress, conversationId, cursor, limit);
    console.log(`Conversation with ${peerAddress}`);
  } else {
    fetchPage = (cursor) => getInboxPage(publicClient, contractAddress, viewerAddress, cursor, limit);
    console.log(`Inbox for ${viewerAddress}`);
  }

  const initialIds = await fetchPage(initialCursor);
  if (initialIds.length === 0) {
    console.log("No messages found.");
  } else {
    const records = await hydrateMessages({
      publicClient,
      contractAddress,
      viewerAddress,
      keyring,
      messageIds: initialIds
    });
    printRecords(records);

    if (!options.follow && initialIds.length === limit) {
      console.log(`Next cursor: ${initialIds[initialIds.length - 1].toString()}`);
    }
  }

  if (!options.follow) {
    return;
  }

  const seenIds = new Set(initialIds.map((messageId) => messageId.toString()));
  for (;;) {
    await sleep(2000);
    const newIds = await collectNewMessageIds({
      fetchPage,
      seenIds,
      pageSize: limit
    });

    if (newIds.length === 0) {
      continue;
    }

    const records = await hydrateMessages({
      publicClient,
      contractAddress,
      viewerAddress,
      keyring,
      messageIds: newIds
    });
    addSeenIds(seenIds, newIds);
    printRecords(records);
  }
});

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

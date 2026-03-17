#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

import { Command } from "commander";

import { createConnections } from "./config.js";
import {
  formatContactLabel,
  importContactsState,
  listContacts,
  readContacts,
  readImportedContacts,
  writeContacts
} from "./contacts.js";
import { launchChatApp } from "./app.js";
import {
  acceptInviteResponseWorkflow,
  cancelInviteWorkflow,
  decodeInviteShareCode,
  listActiveInvitesWorkflow,
  listContactsWorkflow,
  listInviteMatchesWorkflow,
  postInviteWorkflow,
  readInboxWorkflow,
  resolveId,
  respondInviteWorkflow,
  reviewInviteResponsesWorkflow,
  saveContactWorkflow,
  sendMessageWorkflow,
  setupChatWorkflow,
  showContactWorkflow,
  verifyContactWorkflow
} from "./workflows.js";
import {
  formatInviteResponseRecord,
  formatInviteSummary,
  formatStoredMatch
} from "./hub.js";
import { formatMessageRecord } from "./messages.js";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function formatFriendlyError(error) {
  const message = error?.message || String(error);

  if (message.includes("Missing RPC URL")) {
    return `${message} Run \`pnpm chat start\` for the setup wizard.`;
  }

  if (message.includes("Missing contract address")) {
    return `${message} Run \`pnpm chat start\` or set CHATTER_CONTRACT_ADDRESS.`;
  }

  if (message.includes("Missing wallet private key")) {
    return `${message} Run \`pnpm chat start\` or set CHATTER_PRIVATE_KEY.`;
  }

  if (message.includes("Missing local chat keyring")) {
    return `${message} Run \`pnpm chat start\` or \`pnpm chat setup\`.`;
  }

  if (message.includes("Unknown recipient address or alias") || message.includes("Unknown conversation address or alias")) {
    return `${message} Check \`pnpm chat contacts list\` or save the contact first.`;
  }

  if (/insufficient funds|intrinsic gas too low|gas required exceeds/i.test(message)) {
    return `Transaction failed: ${message}. The wallet likely needs gas on the selected chain.`;
  }

  return message;
}

const program = new Command();
program.name("chat").description("Send and read end-to-end encrypted blockchain messages.");
program.showHelpAfterError();

addSharedOptions(
  program
    .command("start")
    .description("Run the setup wizard and open the terminal chat app.")
).action(async (options) => {
  await launchChatApp(options, { runWizard: true });
});

addSharedOptions(
  program
    .command("app")
    .description("Open the interactive terminal chat app.")
).action(async (options) => {
  await launchChatApp(options);
});

addSharedOptions(
  program
    .command("setup")
    .description("Generate a local chat keypair and register the public key on-chain.")
    .option("--rotate", "rotate an existing chat key")
).action(async (options) => {
  const result = await setupChatWorkflow(options, { rotate: Boolean(options.rotate) });

  if (result.alreadyConfigured) {
    console.log(`Chat key already configured for ${result.walletAddress} on chain ${result.chainId}.`);
    return;
  }

  console.log("Submitting chat-key registration...");
  console.log(`Registered chat key version ${result.registration.version.toString()} for ${result.walletAddress}.`);
  console.log(`Contract: ${result.contractAddress}`);
  console.log(`Chain ID: ${result.chainId}`);
  console.log(`Keyring: ${result.keyringPath}`);
  console.log(`Transaction: ${result.registration.hash}`);
});

addSharedOptions(
  program
    .command("send")
    .description("Encrypt a message for a recipient and send it on-chain.")
    .requiredOption("--to <addressOrAlias>", "recipient wallet address or saved alias")
    .requiredOption("--message <text>", "message text")
).action(async (options) => {
  console.log("Encrypting and sending message...");
  const result = await sendMessageWorkflow(options, {
    recipientReference: options.to,
    message: options.message
  });

  console.log(`Sent message ${result.sentMessage.messageId.toString()} to ${result.recipientAddress}.`);
  console.log(`Conversation: ${result.sentMessage.conversationId}`);
  console.log(`Transaction: ${result.sentMessage.hash}`);
});

const contactsCommand = program.command("contacts").description("Manage local aliases and contact metadata.");

addSharedOptions(
  contactsCommand
    .command("list")
    .description("List saved contacts and aliases.")
).action(async (options) => {
  const result = await listContactsWorkflow(options);
  if (result.list.length === 0) {
    console.log("No contacts saved.");
    return;
  }

  for (const contact of result.list) {
    console.log(
      `${contact.alias ?? contact.address} ${contact.verified ? "verified" : "unverified"} ` +
      `${contact.fingerprint ? `fingerprint=${contact.fingerprint}` : ""}`
    );
  }
});

addSharedOptions(
  contactsCommand
    .command("save")
    .description("Save or update a local contact.")
    .requiredOption("--address <address>", "peer wallet address")
    .option("--alias <alias>", "local alias")
    .option("--notes <text>", "contact notes")
    .option("--chain-label <label>", "optional chain label")
).action(async (options) => {
  const result = await saveContactWorkflow(options, {
    address: options.address,
    alias: options.alias,
    notes: options.notes,
    chainLabel: options.chainLabel
  });

  console.log(`Saved contact ${result.contact.alias ?? result.contact.address}.`);
  console.log(`Contacts: ${result.contactsPath}`);
});

addSharedOptions(
  contactsCommand
    .command("show")
    .description("Show contact details, verification state, and fingerprint.")
    .requiredOption("--with <addressOrAlias>", "contact wallet address or alias")
).action(async (options) => {
  const result = await showContactWorkflow(options, { reference: options.with });
  console.log(`Address: ${result.peerAddress}`);
  console.log(`Alias: ${result.contact?.alias ?? "(none)"}`);
  console.log(`Notes: ${result.contact?.notes ?? "(none)"}`);
  console.log(`Verified: ${result.contact?.verified ? "yes" : "no"}`);
  console.log(`Fingerprint: ${result.fingerprint}`);
  console.log(`Active key version: ${result.activeChatKey.version.toString()}`);
});

addSharedOptions(
  contactsCommand
    .command("verify")
    .description("Mark a contact as verified against its current on-chain chat key.")
    .requiredOption("--with <addressOrAlias>", "contact wallet address or alias")
).action(async (options) => {
  const result = await verifyContactWorkflow(options, { reference: options.with });
  console.log(`Verified ${result.contact.alias ?? result.contact.address}.`);
  console.log(`Fingerprint: ${result.contact.fingerprint}`);
  console.log(`Contacts: ${result.contactsPath}`);
});

addSharedOptions(
  contactsCommand
    .command("export")
    .description("Export the local contact book to a JSON file.")
    .requiredOption("--file <path>", "destination JSON file")
).action(async (options) => {
  const { account, chainId } = await createConnections(options);
  const walletAddress = account.address;
  const contacts = await readContacts({ chainId, walletAddress });
  await writeFile(
    options.file,
    `${JSON.stringify(contacts ?? {
      schemaVersion: 1,
      chainId: String(chainId),
      walletAddress,
      contacts: {}
    }, null, 2)}\n`
  );
  console.log(`Exported contacts to ${options.file}.`);
});

addSharedOptions(
  contactsCommand
    .command("import")
    .description("Import contacts from a JSON file and merge them into the local book.")
    .requiredOption("--file <path>", "source JSON file")
).action(async (options) => {
  const { account, chainId } = await createConnections(options);
  const walletAddress = account.address;
  const contacts = await readContacts({ chainId, walletAddress });
  const imported = await readImportedContacts({ filePath: options.file });
  const nextContacts = importContactsState({
    contacts,
    importedContacts: imported,
    chainId,
    walletAddress
  });
  const contactsPath = await writeContacts({
    chainId,
    walletAddress,
    contacts: nextContacts
  });
  console.log(`Imported contacts from ${options.file}.`);
  console.log(`Contacts: ${contactsPath}`);
});

const hubCommand = program.command("hub").description("Browse and answer chain-only rendezvous invites.");

addSharedOptions(
  hubCommand
    .command("post")
    .description("Post an expiring invite commitment and print the private share bundle.")
    .requiredOption("--phrase <phrase>", "phrase A that the responder must know")
    .requiredOption("--expect <phrase>", "reciprocal phrase B the responder must submit")
    .option("--ttl-hours <hours>", "invite lifetime in whole hours (default: 24)")
).action(async (options) => {
  console.log("Submitting invite...");
  const result = await postInviteWorkflow(options, {
    phraseA: options.phrase,
    phraseB: options.expect,
    ttlHours: options.ttlHours
  });

  console.log(`Posted invite ${result.postedInvite.inviteId.toString()} for ${result.walletAddress}.`);
  console.log(`Expires: ${new Date(Number(result.postedInvite.expiresAt) * 1000).toISOString()}`);
  console.log(`Hub state: ${result.hubPath}`);
  console.log("Share privately:");
  console.log(`inviteId=${result.postedInvite.inviteId.toString()}`);
  console.log(`inviteSecret=${result.inviteSecret}`);
  console.log(`phraseA=${options.phrase}`);
  console.log(`phraseB=${options.expect}`);
  console.log(`shareCode=${result.shareCode}`);
  console.log(`Transaction: ${result.postedInvite.hash}`);
});

addSharedOptions(
  hubCommand
    .command("list")
    .description("List active invite IDs from the on-chain rendezvous hub.")
    .option("--cursor <inviteId>", "page older invite IDs starting before this invite")
    .option("--limit <count>", "page size (default: 20)")
).action(async (options) => {
  const result = await listActiveInvitesWorkflow(options, {
    cursor: options.cursor,
    limit: options.limit
  });

  if (result.entries.length === 0) {
    console.log("No active invites found.");
    return;
  }

  for (const entry of result.entries) {
    console.log(formatInviteSummary(entry));
  }

  if (result.nextCursor !== null) {
    console.log(`Next cursor: ${result.nextCursor.toString()}`);
  }
});

addSharedOptions(
  hubCommand
    .command("respond")
    .description("Submit an encrypted response bundle for an active invite.")
    .option("--bundle <shareCode>", "copy-friendly share bundle code from `hub post`")
    .option("--invite-id <id>", "invite identifier")
    .option("--phrase <phrase>", "phrase A shared by the poster")
    .option("--reciprocal <phrase>", "reciprocal phrase B expected by the poster")
    .option("--secret <secret>", "invite secret bundle shared by the poster")
).action(async (options) => {
  let inviteId = options.inviteId;
  let inviteSecret = options.secret;
  let phraseA = options.phrase;
  let phraseB = options.reciprocal;

  if (options.bundle) {
    const parsed = decodeInviteShareCode(options.bundle);
    inviteId = parsed.inviteId;
    inviteSecret = parsed.inviteSecret;
    phraseA = parsed.phraseA;
    phraseB = parsed.phraseB;
  }

  if (!inviteId || !inviteSecret || !phraseA || !phraseB) {
    throw new Error("Provide --bundle or all of --invite-id, --secret, --phrase, and --reciprocal.");
  }

  console.log("Submitting encrypted invite response...");
  const result = await respondInviteWorkflow(options, {
    inviteId: resolveId(inviteId, "Invite ID"),
    inviteSecret,
    phraseA,
    phraseB
  });

  console.log(`Submitted response ${result.submittedResponse.responseId.toString()} for invite ${inviteId}.`);
  console.log(`Poster wallet: ${result.inviteDetails.poster}`);
  console.log(`Poster invite-time key version: ${result.inviteDetails.posterKeyVersion.toString()}`);
  console.log(`Transaction: ${result.submittedResponse.hash}`);
});

addSharedOptions(
  hubCommand
    .command("responses")
    .description("Decrypt and validate invite responses for one of your posted invites.")
    .requiredOption("--invite-id <id>", "invite identifier")
).action(async (options) => {
  const result = await reviewInviteResponsesWorkflow(options, {
    inviteId: resolveId(options.inviteId, "Invite ID")
  });

  if (result.responses.length === 0) {
    console.log("No invite responses found.");
    return;
  }

  for (const response of result.responses) {
    console.log(
      formatInviteResponseRecord({
        responseId: response.responseId,
        header: response.header,
        validation: response.validation
      })
    );
  }
});

addSharedOptions(
  hubCommand
    .command("accept")
    .description("Accept one validated invite response and finalize the match.")
    .requiredOption("--invite-id <id>", "invite identifier")
    .requiredOption("--response-id <id>", "invite response identifier")
).action(async (options) => {
  console.log("Accepting invite response...");
  const result = await acceptInviteResponseWorkflow(options, {
    inviteId: resolveId(options.inviteId, "Invite ID"),
    responseId: resolveId(options.responseId, "Response ID")
  });

  console.log(`Accepted response ${options.responseId} for invite ${options.inviteId}.`);
  console.log(`Peer wallet: ${result.acceptedMatch.responder}`);
  console.log(`Peer key version: ${result.matchRecord.responderKeyVersion.toString()}`);
  console.log(`Fingerprint: ${result.contactUpdate.fingerprint}`);
  console.log(`Contacts: ${result.contactUpdate.contactsPath}`);
  console.log(`Transaction: ${result.acceptedMatch.hash}`);
});

addSharedOptions(
  hubCommand
    .command("matches")
    .description("Show accepted invite matches involving the current wallet.")
).action(async (options) => {
  const result = await listInviteMatchesWorkflow(options);

  if (result.matches.length === 0) {
    console.log("No invite matches found.");
    return;
  }

  for (const entry of result.matches) {
    console.log(
      formatStoredMatch({
        inviteId: String(entry.inviteId),
        role: entry.peer.role,
        peerWalletAddress: entry.peer.peerWalletAddress,
        peerKeyVersion: entry.peer.peerKeyVersion,
        matchedAt: Number(entry.matchRecord.matchedAt)
      })
    );
  }

  if (result.contactsPath) {
    console.log(`Contacts: ${result.contactsPath}`);
  }
});

addSharedOptions(
  hubCommand
    .command("cancel")
    .description("Cancel one of your active invites.")
    .requiredOption("--invite-id <id>", "invite identifier")
).action(async (options) => {
  console.log("Cancelling invite...");
  const result = await cancelInviteWorkflow(options, {
    inviteId: resolveId(options.inviteId, "Invite ID")
  });

  console.log(`Cancelled invite ${result.cancelledInvite.inviteId.toString()}.`);
  console.log(`Transaction: ${result.cancelledInvite.hash}`);
});

addSharedOptions(
  program
    .command("inbox")
    .description("Read and decrypt messages for the current wallet.")
    .option("--with <addressOrAlias>", "show a full conversation with a specific peer")
    .option("--cursor <messageId>", "page older messages starting before this message ID")
    .option("--limit <count>", "page size (default: 20)")
    .option("--follow", "poll every 2 seconds for new messages")
).action(async (options) => {
  if (options.follow && options.cursor !== undefined) {
    throw new Error("--follow cannot be combined with --cursor.");
  }

  const result = await readInboxWorkflow(options, {
    peerReference: options.with,
    cursor: options.cursor,
    limit: options.limit
  });

  if (result.peerAddress) {
    console.log(`Conversation with ${formatContactLabel(result.contacts, result.peerAddress)} (${result.peerAddress})`);
  } else {
    console.log(`Inbox for ${result.viewerAddress}`);
  }

  if (result.records.length === 0) {
    console.log("No messages found.");
    return;
  }

  printRecords(result.records);
  if (result.nextCursor !== null) {
    console.log(`Next cursor: ${result.nextCursor.toString()}`);
  }

  if (!options.follow) {
    return;
  }

  const seen = new Set(result.records.map((record) => record.messageId.toString()));
  for (;;) {
    await sleep(2000);
    const refreshed = await readInboxWorkflow(options, {
      peerReference: options.with,
      cursor: 0n,
      limit: options.limit
    });
    const freshRecords = refreshed.records.filter((record) => !seen.has(record.messageId.toString()));

    if (freshRecords.length === 0) {
      continue;
    }

    freshRecords.sort((left, right) => (left.messageId < right.messageId ? -1 : 1));
    printRecords(freshRecords);
    for (const record of freshRecords) {
      seen.add(record.messageId.toString());
    }
  }
});

program.parseAsync(process.argv).catch((error) => {
  console.error(formatFriendlyError(error));
  process.exit(1);
});

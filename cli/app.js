import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { getAddress } from "viem";

import { createConnections } from "./config.js";
import {
  formatChatKeyFingerprint,
  formatContactLabel,
  getContact,
  listContacts,
  readContacts
} from "./contacts.js";
import { readHubState } from "./hub.js";
import { hydrateMessages } from "./messages.js";
import { getConversationId, getConversationPage, getInboxPage, getMatchRecord } from "./contract.js";
import { getUnreadCount, readAppState, updateAppSettings, upsertConversationState, writeAppState } from "./app-state.js";
import { getActiveLocalKey, localKeyMatchesOnChain, readKeyring } from "./keyring.js";
import {
  cancelInviteWorkflow,
  decodeInviteShareCode,
  listActiveInvitesWorkflow,
  listContactsWorkflow,
  listInviteMatchesWorkflow,
  loadActiveLocalKeyOrThrow,
  loadKeyringOrThrow,
  postInviteWorkflow,
  readInboxWorkflow,
  respondInviteWorkflow,
  reviewInviteResponsesWorkflow,
  acceptInviteResponseWorkflow,
  saveContactWorkflow,
  sendMessageWorkflow,
  setupChatWorkflow,
  showContactWorkflow,
  verifyContactWorkflow
} from "./workflows.js";

function clearScreen() {
  output.write("\x1bc");
}

function divider(label = "") {
  const line = "=".repeat(64);
  return label ? `${line}\n${label}\n${line}` : line;
}

function truncate(value, maxLength = 56) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatRelativeTime(dateValue) {
  if (!dateValue) {
    return "never";
  }

  const timestamp = typeof dateValue === "number" ? dateValue : Number(dateValue);
  const diffMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function messageTimestamp(record, showExactTimestamps) {
  const value = record?.createdAt ?? Number(record?.header?.sentAt ?? 0n) * 1000;
  if (!value) {
    return "unknown";
  }

  return showExactTimestamps ? new Date(value).toISOString() : formatRelativeTime(value);
}

function conversationPreview(record) {
  if (!record) {
    return "No messages yet.";
  }

  const prefix = record.direction === "out" ? "you: " : "";
  return truncate(`${prefix}${record.decrypted ? record.text : record.message}`, 44);
}

async function promptLine(rl, label, { allowEmpty = false, defaultValue = "" } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";

  for (;;) {
    const answer = await rl.question(`${label}${suffix}: `);
    const nextValue = answer.trim() || defaultValue;

    if (nextValue || allowEmpty) {
      return nextValue;
    }
  }
}

async function confirm(rl, label, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();

  if (!answer) {
    return defaultYes;
  }

  return answer === "y" || answer === "yes";
}

async function pause(rl, label = "Press Enter to continue") {
  await rl.question(`${label}...`);
}

async function ensureSessionOptions(baseOptions, rl, { interactive }) {
  const nextOptions = {
    rpcUrl: baseOptions.rpcUrl || process.env.CHATTER_RPC_URL,
    contractAddress: baseOptions.contractAddress || process.env.CHATTER_CONTRACT_ADDRESS,
    privateKey: baseOptions.privateKey || process.env.CHATTER_PRIVATE_KEY
  };

  if (!interactive) {
    return nextOptions;
  }

  if (!nextOptions.rpcUrl) {
    nextOptions.rpcUrl = await promptLine(rl, "RPC URL", {
      defaultValue: "http://127.0.0.1:8545"
    });
  }

  if (!nextOptions.contractAddress) {
    nextOptions.contractAddress = await promptLine(rl, "Contract address");
  }

  if (!nextOptions.privateKey) {
    nextOptions.privateKey = await promptLine(rl, "Wallet private key");
  }

  return nextOptions;
}

async function inspectHealth(options) {
  const { publicClient, account, chainId, contractAddress, rpcUrl } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const keyring = await readKeyring({ chainId, walletAddress });
  const onChainKey = await publicClient.readContract({
    address: contractAddress,
    abi: [
      {
        type: "function",
        name: "activeChatKeys",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [
          { name: "version", type: "uint64" },
          { name: "pubKey", type: "bytes32" }
        ]
      }
    ],
    functionName: "activeChatKeys",
    args: [walletAddress]
  });
  const localKey = getActiveLocalKey(keyring);
  const matchesLocal = keyring
    ? localKeyMatchesOnChain({
      keyring,
      onChainVersion: onChainKey[0],
      onChainPubKey: onChainKey[1]
    })
    : false;
  const contacts = await readContacts({ chainId, walletAddress });
  const hubState = await readHubState({ chainId, walletAddress });
  const appState = await readAppState({ chainId, walletAddress });

  let status = "ready";
  if (!keyring) {
    status = "missing-local-keyring";
  } else if (!localKey) {
    status = "missing-local-key";
  } else if (BigInt(onChainKey[0]) === 0n) {
    status = "missing-onchain-key";
  } else if (!matchesLocal) {
    status = "key-mismatch";
  }

  return {
    status,
    rpcUrl,
    contractAddress,
    chainId,
    walletAddress,
    keyring,
    localKey,
    onChainKey: {
      version: BigInt(onChainKey[0]),
      pubKey: onChainKey[1]
    },
    contacts,
    hubState,
    appState
  };
}

async function runSetupWizard(options, rl) {
  const health = await inspectHealth(options);

  if (health.status === "ready") {
    return {
      health,
      message: `Chat key ready for ${health.walletAddress}.`
    };
  }

  let message = "";
  if (health.status === "key-mismatch") {
    const rotate = await confirm(rl, "Local key is out of sync. Rotate the chat key now?");
    if (rotate) {
      const result = await setupChatWorkflow(options, { rotate: true });
      message = `Rotated chat key to version ${result.registration.version.toString()}.`;
    }
  } else {
    const register = await confirm(rl, "No usable chat key found. Register one now?");
    if (register) {
      const result = await setupChatWorkflow(options);
      message = result.alreadyConfigured
        ? `Chat key already configured for ${result.walletAddress}.`
        : `Registered chat key version ${result.registration.version.toString()}.`;
    }
  }

  return {
    health: await inspectHealth(options),
    message
  };
}

async function buildConversationSummaries(options) {
  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const viewerAddress = getAddress(account.address);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress: viewerAddress });
  const contacts = await readContacts({ chainId, walletAddress: viewerAddress });
  const appState = await readAppState({ chainId, walletAddress: viewerAddress });
  const inboxIds = await getInboxPage(publicClient, contractAddress, viewerAddress, 0n, 25n);
  const inboxRecords = inboxIds.length === 0
    ? []
    : await hydrateMessages({
      publicClient,
      contractAddress,
      viewerAddress,
      keyring,
      messageIds: inboxIds
    });
  const matchesData = await listInviteMatchesWorkflow(options);
  const peerSet = new Set([
    ...listContacts(contacts).map((contact) => getAddress(contact.address).toLowerCase()),
    ...matchesData.matches.map((entry) => getAddress(entry.peer.peerWalletAddress).toLowerCase()),
    ...inboxRecords
      .map((record) => {
        if (record.header.sender.toLowerCase() === viewerAddress.toLowerCase()) {
          return record.header.recipient;
        }

        return record.header.sender;
      })
      .map((address) => getAddress(address).toLowerCase())
  ]);
  const summaries = [];

  for (const peerWalletAddress of peerSet) {
    const peerAddress = getAddress(peerWalletAddress);
    const conversationId = await getConversationId(publicClient, contractAddress, viewerAddress, peerAddress);
    const messageIds = await getConversationPage(publicClient, contractAddress, conversationId, 0n, 25n);
    const records = messageIds.length === 0
      ? []
      : await hydrateMessages({
        publicClient,
        contractAddress,
        viewerAddress,
        keyring,
        messageIds
      });
    const lastRecord = records.at(-1) ?? null;
    const contact = getContact(contacts, peerAddress);

    summaries.push({
      peerAddress,
      contact,
      lastRecord,
      unreadCount: getUnreadCount({
        appState,
        peerWalletAddress: peerAddress,
        records
      }),
      draft: appState?.conversations?.[peerAddress.toLowerCase()]?.draft ?? "",
      verified: Boolean(contact?.verified)
    });
  }

  return summaries.sort((left, right) => {
    const leftStamp = left.lastRecord?.createdAt ?? Number(left.lastRecord?.header?.sentAt ?? 0n) * 1000;
    const rightStamp = right.lastRecord?.createdAt ?? Number(right.lastRecord?.header?.sentAt ?? 0n) * 1000;
    return rightStamp - leftStamp;
  });
}

function renderConversationList({ summaries, contacts, filter, showExactTimestamps }) {
  const filtered = filter
    ? summaries.filter((summary) => {
      const label = formatContactLabel(contacts, summary.peerAddress).toLowerCase();
      const preview = conversationPreview(summary.lastRecord).toLowerCase();
      return label.includes(filter.toLowerCase()) || preview.includes(filter.toLowerCase());
    })
    : summaries;

  if (filtered.length === 0) {
    return ["No conversations yet."];
  }

  return filtered.slice(0, 8).map((summary, index) => {
    const unread = summary.unreadCount > 0 ? ` unread=${summary.unreadCount}` : "";
    const draft = summary.draft ? " draft" : "";
    return [
      `${index + 1}. ${formatContactLabel(contacts, summary.peerAddress)}${summary.verified ? " verified" : ""}${unread}${draft}`,
      `   ${conversationPreview(summary.lastRecord)} · ${messageTimestamp(summary.lastRecord, showExactTimestamps)}`
    ].join("\n");
  });
}

async function renderHome({ options, filter }) {
  const health = await inspectHealth(options);
  const summaries = await buildConversationSummaries(options);
  const matches = await listInviteMatchesWorkflow(options);
  const activeInvites = await listActiveInvitesWorkflow(options, { cursor: 0n, limit: 8 });

  return {
    health,
    summaries,
    matches,
    activeInvites,
    filter
  };
}

async function openConversationScreen(rl, options, peerReference) {
  for (;;) {
    const thread = await readInboxWorkflow(options, {
      peerReference,
      cursor: 0n,
      limit: 25
    });
    const health = await inspectHealth(options);
    const appState = await readAppState({ chainId: health.chainId, walletAddress: health.walletAddress });
    const contactInfo = await showContactWorkflow(options, { reference: thread.peerAddress });
    const latestMessageId = thread.records.at(-1)?.messageId ?? null;
    let nextAppState = appState;

    if (latestMessageId) {
      nextAppState = upsertConversationState({
        appState,
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        peerWalletAddress: thread.peerAddress,
        lastSeenMessageId: latestMessageId,
        lastOpenedAt: new Date().toISOString()
      });
      await writeAppState({
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        appState: nextAppState
      });
    }

    clearScreen();
    console.log(divider("Conversation"));
    console.log(`Peer: ${formatContactLabel(thread.contacts, thread.peerAddress)} (${thread.peerAddress})`);
    console.log(`Fingerprint: ${contactInfo.fingerprint}`);
    console.log(`Verified: ${contactInfo.contact?.verified ? "yes" : "no"}`);
    console.log(divider("Messages"));

    if (thread.records.length === 0) {
      console.log("No messages yet.");
    } else {
      const showExactTimestamps = nextAppState?.settings?.showExactTimestamps ?? false;
      for (const record of thread.records.slice(-15)) {
        const timestamp = messageTimestamp(record, showExactTimestamps);
        const senderLabel = record.direction === "out"
          ? "you"
          : formatContactLabel(thread.contacts, thread.peerAddress);
        console.log(`[${timestamp}] ${senderLabel}: ${record.decrypted ? record.text : record.message}`);
      }
    }

    const currentDraft = nextAppState?.conversations?.[thread.peerAddress.toLowerCase()]?.draft ?? "";
    console.log(divider("Composer"));
    console.log(`Draft: ${currentDraft ? truncate(currentDraft, 80) : "(empty)"}`);
    const action = (await rl.question("thread> [type/send/save/verify/refresh/back]: ")).trim().toLowerCase();

    if (!action || action === "back") {
      return;
    }

    if (action === "refresh") {
      continue;
    }

    if (action === "type") {
      const draft = await promptLine(rl, "Draft text", {
        allowEmpty: true,
        defaultValue: currentDraft
      });
      nextAppState = upsertConversationState({
        appState: nextAppState,
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        peerWalletAddress: thread.peerAddress,
        draft
      });
      await writeAppState({
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        appState: nextAppState
      });
      continue;
    }

    if (action === "send") {
      const text = currentDraft || (await promptLine(rl, "Message text"));
      const sent = await sendMessageWorkflow(options, {
        recipientReference: thread.peerAddress,
        message: text
      });
      nextAppState = upsertConversationState({
        appState: nextAppState,
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        peerWalletAddress: thread.peerAddress,
        draft: ""
      });
      await writeAppState({
        chainId: health.chainId,
        walletAddress: health.walletAddress,
        appState: nextAppState
      });
      await pause(rl, `Sent message ${sent.sentMessage.messageId.toString()}`);
      continue;
    }

    if (action === "save") {
      const existingContact = contactInfo.contact;
      const alias = await promptLine(rl, "Alias", {
        allowEmpty: true,
        defaultValue: existingContact?.alias ?? ""
      });
      const notes = await promptLine(rl, "Notes", {
        allowEmpty: true,
        defaultValue: existingContact?.notes ?? ""
      });
      await saveContactWorkflow(options, {
        address: thread.peerAddress,
        alias,
        notes,
        chainLabel: String(health.chainId)
      });
      await pause(rl, "Contact saved");
      continue;
    }

    if (action === "verify") {
      const result = await verifyContactWorkflow(options, { reference: thread.peerAddress });
      await pause(rl, `Verified ${result.contact.alias ?? result.contact.address}`);
      continue;
    }
  }
}

async function openHubScreen(rl, options) {
  for (;;) {
    const health = await inspectHealth(options);
    const activeInvites = await listActiveInvitesWorkflow(options, { cursor: 0n, limit: 8 });
    const matches = await listInviteMatchesWorkflow(options);
    const myInvites = Object.values(health.hubState?.invites ?? {}).filter((invite) => invite.role === "poster");

    clearScreen();
    console.log(divider("Hub"));
    console.log(`Active public invites: ${activeInvites.entries.length}`);
    console.log(`Your posted invites: ${myInvites.length}`);
    console.log(`Matches: ${matches.matches.length}`);
    console.log(divider("Public Invites"));
    if (activeInvites.entries.length === 0) {
      console.log("No active invites.");
    } else {
      for (const entry of activeInvites.entries.slice(0, 5)) {
        console.log(`#${entry.inviteId.toString()} poster=${entry.invite.poster} expires=${new Date(Number(entry.invite.expiresAt) * 1000).toISOString()}`);
      }
    }
    console.log(divider("Your Invites"));
    if (myInvites.length === 0) {
      console.log("No local invite records.");
    } else {
      for (const invite of myInvites.slice(-5)) {
        console.log(`#${invite.inviteId} ${invite.status} expires=${invite.expiresAt ? new Date(Number(invite.expiresAt) * 1000).toISOString() : "unknown"}`);
      }
    }
    console.log(divider("Actions"));
    const action = (await rl.question("hub> [post/respond/review/cancel/matches/back]: ")).trim().toLowerCase();

    if (!action || action === "back") {
      return;
    }

    if (action === "post") {
      const phraseA = await promptLine(rl, "Phrase A");
      const phraseB = await promptLine(rl, "Phrase B");
      const ttlHours = await promptLine(rl, "TTL hours", {
        defaultValue: "24"
      });
      const posted = await postInviteWorkflow(options, {
        phraseA,
        phraseB,
        ttlHours
      });
      await pause(rl, `Invite ${posted.postedInvite.inviteId.toString()} posted. Share code: ${posted.shareCode}`);
      continue;
    }

    if (action === "respond") {
      const shareCode = await promptLine(rl, "Share code (leave blank for manual entry)", {
        allowEmpty: true
      });
      let inviteId;
      let inviteSecret;
      let phraseA;
      let phraseB;

      if (shareCode) {
        const bundle = decodeInviteShareCode(shareCode);
        inviteId = bundle.inviteId;
        inviteSecret = bundle.inviteSecret;
        phraseA = bundle.phraseA;
        phraseB = bundle.phraseB;
      } else {
        inviteId = await promptLine(rl, "Invite ID");
        inviteSecret = await promptLine(rl, "Invite secret");
        phraseA = await promptLine(rl, "Phrase A");
        phraseB = await promptLine(rl, "Phrase B");
      }

      const response = await respondInviteWorkflow(options, {
        inviteId,
        inviteSecret,
        phraseA,
        phraseB
      });
      await pause(rl, `Submitted response ${response.submittedResponse.responseId.toString()}`);
      continue;
    }

    if (action === "review") {
      const inviteId = await promptLine(rl, "Invite ID to review");
      const review = await reviewInviteResponsesWorkflow(options, { inviteId });
      clearScreen();
      console.log(divider(`Responses for Invite #${inviteId}`));
      if (review.responses.length === 0) {
        console.log("No invite responses.");
      } else {
        for (const response of review.responses) {
          console.log(
            `#${response.responseId.toString()} responder=${response.header.responder} ` +
            `${response.validation.valid ? "valid" : `invalid (${response.validation.errors.join(", ")})`}`
          );
        }
      }
      const accept = await promptLine(rl, "Accept response ID (blank to skip)", {
        allowEmpty: true
      });
      if (accept) {
        const selectedResponse = review.responses.find((response) => response.responseId.toString() === accept);
        const contacts = await readContacts({
          chainId: health.chainId,
          walletAddress: health.walletAddress
        });
        const responderContact = selectedResponse
          ? getContact(contacts, selectedResponse.header.responder)
          : null;

        if (!selectedResponse) {
          await pause(rl, `Unknown response ID ${accept}`);
          continue;
        }

        if (!responderContact?.verified) {
          const shouldAccept = await confirm(
            rl,
            `Responder ${selectedResponse.header.responder} is not verified locally. Accept anyway?`,
            false
          );
          if (!shouldAccept) {
            continue;
          }
        }

        const accepted = await acceptInviteResponseWorkflow(options, {
          inviteId,
          responseId: accept
        });
        await pause(rl, `Accepted ${accepted.acceptedMatch.responder}`);
      } else {
        await pause(rl);
      }
      continue;
    }

    if (action === "matches") {
      clearScreen();
      console.log(divider("Matches"));
      if (matches.matches.length === 0) {
        console.log("No matches.");
      } else {
        for (const entry of matches.matches) {
          console.log(
            `#${entry.inviteId.toString()} peer=${entry.peer.peerWalletAddress} ` +
            `matched=${new Date(Number(entry.matchRecord.matchedAt) * 1000).toISOString()}`
          );
        }
      }
      await pause(rl);
      continue;
    }

    if (action === "cancel") {
      const inviteId = await promptLine(rl, "Invite ID to cancel");
      await cancelInviteWorkflow(options, { inviteId });
      await pause(rl, `Cancelled invite ${inviteId}`);
      continue;
    }
  }
}

async function openContactsScreen(rl, options) {
  for (;;) {
    const contactsData = await listContactsWorkflow(options);

    clearScreen();
    console.log(divider("Contacts"));
    if (contactsData.list.length === 0) {
      console.log("No contacts saved.");
    } else {
      for (const [index, contact] of contactsData.list.entries()) {
        console.log(
          `${index + 1}. ${contact.alias ?? contact.address} ` +
          `${contact.verified ? "verified" : "unverified"} ` +
          `${contact.fingerprint ? `fingerprint=${contact.fingerprint}` : ""}`
        );
      }
    }

    const action = (await rl.question("contacts> [show/save/verify/export/import/back]: ")).trim().toLowerCase();
    if (!action || action === "back") {
      return;
    }

    if (action === "show") {
      const reference = await promptLine(rl, "Address or alias");
      const contact = await showContactWorkflow(options, { reference });
      clearScreen();
      console.log(divider("Contact Details"));
      console.log(`Address: ${contact.peerAddress}`);
      console.log(`Alias: ${contact.contact?.alias ?? "(none)"}`);
      console.log(`Notes: ${contact.contact?.notes ?? "(none)"}`);
      console.log(`Verified: ${contact.contact?.verified ? "yes" : "no"}`);
      console.log(`Fingerprint: ${contact.fingerprint}`);
      await pause(rl);
      continue;
    }

    if (action === "save") {
      const address = await promptLine(rl, "Address");
      const alias = await promptLine(rl, "Alias", { allowEmpty: true });
      const notes = await promptLine(rl, "Notes", { allowEmpty: true });
      await saveContactWorkflow(options, {
        address,
        alias,
        notes
      });
      await pause(rl, "Contact saved");
      continue;
    }

    if (action === "verify") {
      const reference = await promptLine(rl, "Address or alias");
      const result = await verifyContactWorkflow(options, { reference });
      await pause(rl, `Verified fingerprint ${formatChatKeyFingerprint(result.activeChatKey.pubKey)}`);
      continue;
    }

    if (action === "export") {
      const filePath = await promptLine(rl, "Export path");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, `${JSON.stringify(contactsData.contacts ?? {
        schemaVersion: 1,
        chainId: contactsData.chainId,
        walletAddress: contactsData.walletAddress,
        contacts: {}
      }, null, 2)}\n`);
      await pause(rl, `Exported to ${filePath}`);
      continue;
    }

    if (action === "import") {
      const filePath = await promptLine(rl, "Import path");
      const { importContactsState, readImportedContacts, writeContacts } = await import("./contacts.js");
      const imported = await readImportedContacts({ filePath });
      const nextContacts = importContactsState({
        contacts: contactsData.contacts,
        importedContacts: imported,
        chainId: contactsData.chainId,
        walletAddress: contactsData.walletAddress
      });
      await writeContacts({
        chainId: contactsData.chainId,
        walletAddress: contactsData.walletAddress,
        contacts: nextContacts
      });
      await pause(rl, `Imported contacts from ${filePath}`);
      continue;
    }
  }
}

async function openSettingsScreen(rl, options) {
  const { account, chainId } = await createConnections(options);
  const walletAddress = getAddress(account.address);

  for (;;) {
    const appState = await readAppState({ chainId, walletAddress });
    const settings = appState?.settings ?? { pollSeconds: 2, showExactTimestamps: false };

    clearScreen();
    console.log(divider("Settings"));
    console.log(`Poll interval: ${settings.pollSeconds}s`);
    console.log(`Exact timestamps: ${settings.showExactTimestamps ? "on" : "off"}`);

    const action = (await rl.question("settings> [poll/timestamps/back]: ")).trim().toLowerCase();
    if (!action || action === "back") {
      return;
    }

    if (action === "poll") {
      const pollSeconds = Number(await promptLine(rl, "Poll seconds", {
        defaultValue: String(settings.pollSeconds)
      }));
      const nextState = updateAppSettings({
        appState,
        chainId,
        walletAddress,
        settings: { pollSeconds }
      });
      await writeAppState({
        chainId,
        walletAddress,
        appState: nextState
      });
      continue;
    }

    if (action === "timestamps") {
      const nextState = updateAppSettings({
        appState,
        chainId,
        walletAddress,
        settings: {
          showExactTimestamps: !settings.showExactTimestamps
        }
      });
      await writeAppState({
        chainId,
        walletAddress,
        appState: nextState
      });
      continue;
    }
  }
}

export async function launchChatApp(baseOptions, { runWizard = false } = {}) {
  const rl = createInterface({ input, output });
  let options;
  let filter = "";
  let wizardMessage = "";

  try {
    options = await ensureSessionOptions(baseOptions, rl, { interactive: runWizard });

    if (runWizard) {
      clearScreen();
      console.log(divider("Welcome To ChatterBlocks"));
      console.log("This client keeps message contents encrypted, but wallet activity stays public on-chain.");
      const wizardResult = await runSetupWizard(options, rl);
      wizardMessage = wizardResult.message;
    }

    for (;;) {
      const home = await renderHome({ options, filter });
      clearScreen();
      console.log(divider("ChatterBlocks App"));
      console.log(`Wallet: ${home.health.walletAddress}`);
      console.log(`Chain: ${home.health.chainId}`);
      console.log(`RPC: ${home.health.rpcUrl}`);
      console.log(`Contract: ${home.health.contractAddress}`);
      console.log(`Status: ${home.health.status}`);
      if (wizardMessage) {
        console.log(`Last action: ${wizardMessage}`);
      }
      console.log(divider("Conversations"));
      for (const line of renderConversationList({
        summaries: home.summaries,
        contacts: home.health.contacts,
        filter,
        showExactTimestamps: home.health.appState?.settings?.showExactTimestamps ?? false
      })) {
        console.log(line);
      }
      console.log(divider("Hub & Contacts"));
      console.log(`Matches: ${home.matches.matches.length}`);
      console.log(`Public invites: ${home.activeInvites.entries.length}`);
      console.log(`Saved contacts: ${listContacts(home.health.contacts).length}`);
      console.log(divider("Actions"));
      console.log("1-8 open conversation | new | hub | contacts | settings | setup | search | refresh | quit");

      const action = (await rl.question("app> ")).trim();
      if (!action || action.toLowerCase() === "refresh") {
        continue;
      }

      const normalized = action.toLowerCase();
      if (normalized === "quit" || normalized === "q") {
        return;
      }

      if (normalized === "new") {
        const reference = await promptLine(rl, "Address or alias");
        await openConversationScreen(rl, options, reference);
        continue;
      }

      if (normalized === "hub") {
        await openHubScreen(rl, options);
        continue;
      }

      if (normalized === "contacts") {
        await openContactsScreen(rl, options);
        continue;
      }

      if (normalized === "settings") {
        await openSettingsScreen(rl, options);
        continue;
      }

      if (normalized === "setup") {
        const wizardResult = await runSetupWizard(options, rl);
        wizardMessage = wizardResult.message || "Health check complete.";
        continue;
      }

      if (normalized.startsWith("search")) {
        filter = normalized === "search"
          ? await promptLine(rl, "Search", { allowEmpty: true })
          : action.slice("search".length).trim();
        continue;
      }

      const index = Number(action);
      if (Number.isInteger(index) && index > 0 && index <= home.summaries.length) {
        await openConversationScreen(rl, options, home.summaries[index - 1].peerAddress);
        continue;
      }

      wizardMessage = `Unknown action: ${action}`;
    }
  } finally {
    rl.close();
  }
}

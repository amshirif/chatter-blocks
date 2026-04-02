import { createInterface } from "node:readline/promises";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { getAddress, isAddress } from "viem";

import { createConnections } from "./config.js";
import {
  formatChatKeyFingerprint,
  formatContactLabel,
  getContact,
  listContacts,
  readContacts,
  validateContactAlias
} from "./contacts.js";
import { getHubPath, readHubState } from "./hub.js";
import { hydrateMessages } from "./messages.js";
import { getConversationId, getConversationPage, getInboxPage } from "./contract.js";
import { getUnreadCount, readAppState, updateAppSettings, upsertConversationState, writeAppState } from "./app-state.js";
import { getActiveLocalKey, getKeyringPath, localKeyMatchesOnChain, readKeyring } from "./keyring.js";
import { defaultPassphrase, isEncryptedSecretEnvelope } from "./secret-store.js";
import {
  cancelInviteWorkflow,
  decodeInviteShareCode,
  encodeInviteShareCode,
  listActiveInvitesWorkflow,
  listContactsWorkflow,
  listInviteMatchesWorkflow,
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

const BACK = Symbol("back");
const ROUTE_HOME = Symbol("home");
const LOCAL_SECRET_STATE_LABELS = {
  plaintext: "plaintext",
  "encrypted-unlocked": "encrypted and unlocked",
  "encrypted-locked": "encrypted and locked",
  "not-initialized": "not initialized"
};

class QuitAppError extends Error {
  constructor() {
    super("Quit requested");
    this.name = "QuitAppError";
  }
}

function clearScreen() {
  output.write("\x1bc");
}

function divider(label = "") {
  const line = "=".repeat(64);
  return label ? `${line}\n${label}\n${line}` : line;
}

async function readJsonFileIfExists(filePath) {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
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

function normalizeChoice(rawValue) {
  return String(rawValue ?? "").trim().toLowerCase();
}

function describeHealthStatus(status) {
  switch (status) {
    case "ready":
      return "ready";
    case "missing-local-keyring":
      return "missing local keyring";
    case "missing-local-key":
      return "missing local key";
    case "missing-onchain-key":
      return "missing on-chain key";
    case "key-mismatch":
      return "local/on-chain key mismatch";
    default:
      return status;
  }
}

export function resolveMenuSelection(rawChoice, actions, { allowBack = true, allowQuit = true } = {}) {
  const choice = normalizeChoice(rawChoice);

  if (!choice) {
    return { type: "invalid", error: "Choose one of the listed actions." };
  }

  if (allowQuit && (choice === "q" || choice === "quit")) {
    return { type: "quit" };
  }

  if (allowBack && (choice === "b" || choice === "back")) {
    return { type: "back" };
  }

  const action = actions.find((entry) => normalizeChoice(entry.key) === choice);
  if (action) {
    return { type: "action", action };
  }

  const allowed = actions.map((entry) => entry.key);
  if (allowBack) {
    allowed.push("b");
  }
  if (allowQuit) {
    allowed.push("q");
  }

  return {
    type: "invalid",
    error: `Invalid choice. Enter one of: ${allowed.join(", ")}.`
  };
}

export function formatCopyBlock(label, value) {
  return `${label}:\n${value}`;
}

export function formatLocalSecretStateLabel(status) {
  return LOCAL_SECRET_STATE_LABELS[status] ?? status;
}

function renderNotices({ notice, error }) {
  if (!notice && !error) {
    return;
  }

  console.log(divider("Notices"));
  if (notice) {
    console.log(notice);
  }
  if (error) {
    if (notice) {
      console.log();
    }
    console.log(`Error: ${error}`);
  }
}

function renderActionFooter(actions, { allowBack = true, allowQuit = true } = {}) {
  console.log(divider("Actions"));
  for (const action of actions) {
    console.log(`${action.key}. ${action.label}`);
  }
  if (allowBack) {
    console.log("b. Back");
  }
  if (allowQuit) {
    console.log("q. Quit");
  }
}

export function buildPromptFooterLines({ allowBack = true, allowQuit = true, helpLines = [] } = {}) {
  const lines = [];

  for (const line of helpLines) {
    lines.push(line);
  }
  if (allowBack) {
    lines.push("b. Back");
  }
  if (allowQuit) {
    lines.push("q. Quit");
  }

  return lines;
}

function renderPromptScreen({
  title,
  bodyLines = [],
  error,
  allowBack = true,
  allowQuit = true,
  helpLines = []
}) {
  clearScreen();
  console.log(divider(title));
  for (const line of bodyLines) {
    console.log(line);
  }
  renderNotices({ error });
  console.log(divider("Prompt"));
  for (const line of buildPromptFooterLines({ allowBack, allowQuit, helpLines })) {
    console.log(line);
  }
}

async function promptMenuChoice(rl, actions, { prompt = "Select", allowBack = true, allowQuit = true } = {}) {
  const answer = await askQuestion(rl, `${prompt}: `);
  const resolved = resolveMenuSelection(answer, actions, { allowBack, allowQuit });

  if (resolved.type === "quit") {
    throw new QuitAppError();
  }

  if (resolved.type === "back") {
    return BACK;
  }

  return resolved;
}

async function askQuestion(rl, prompt) {
  try {
    return await rl.question(prompt);
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("readline was closed") || message.includes("readline closed")) {
      throw new QuitAppError();
    }

    throw error;
  }
}

async function promptLine(
  rl,
  label,
  {
    allowEmpty = false,
    defaultValue = "",
    validate,
    allowBack = true,
    screen
  } = {}
) {
  let error = "";

  for (;;) {
    if (screen) {
      renderPromptScreen({
        title: screen.title,
        bodyLines: typeof screen.bodyLines === "function" ? screen.bodyLines() : (screen.bodyLines ?? []),
        error,
        allowBack,
        allowQuit: true,
        helpLines: screen.helpLines ?? []
      });
    } else if (error) {
      console.log(`Error: ${error}`);
    }

    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await askQuestion(rl, `${label}${suffix}: `);
    const rawValue = answer.trim();
    const normalized = normalizeChoice(rawValue);

    if (allowBack && (normalized === "b" || normalized === "back")) {
      return BACK;
    }

    if (normalized === "q" || normalized === "quit") {
      throw new QuitAppError();
    }

    const nextValue = rawValue || defaultValue;
    if (!nextValue && !allowEmpty) {
      error = `${label} is required.`;
      continue;
    }

    if (validate) {
      const validationError = await validate(nextValue);
      if (validationError) {
        error = validationError;
        continue;
      }
    }

    return nextValue;
  }
}

function validateContractAddressInput(value) {
  try {
    getAddress(value);
    return null;
  } catch {
    return "Contract address must be a valid EVM address.";
  }
}

function validatePrivateKeyInput(value) {
  if (!/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    return "Wallet private key must be a 32-byte hex string starting with 0x.";
  }

  return null;
}

function validateWalletAddressInput(value, label = "Address") {
  if (!isAddress(value)) {
    return `${label} must be a valid EVM address.`;
  }

  return null;
}

function validateConversationReferenceInput(value) {
  if (isAddress(value)) {
    return null;
  }

  const aliasError = validateContactAlias(value, { allowEmpty: false });
  if (aliasError) {
    return "Enter a valid wallet address or a simple alias using letters, numbers, spaces, ., _, and -.";
  }

  return null;
}

async function validateImportFilePath(value) {
  try {
    await access(value, fsConstants.R_OK);
    return null;
  } catch {
    return "Import path must point to a readable file.";
  }
}

async function validateExportFilePath(value) {
  const directory = path.dirname(path.resolve(value));

  try {
    await access(directory, fsConstants.W_OK);
    return null;
  } catch {
    return `Export directory must exist and be writable: ${directory}`;
  }
}

async function confirm(rl, label, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";

  for (;;) {
    const answer = (await askQuestion(rl, `${label}${suffix}: `)).trim().toLowerCase();

    if (!answer) {
      return defaultYes;
    }

    if (answer === "q" || answer === "quit") {
      throw new QuitAppError();
    }

    if (answer === "b" || answer === "back") {
      return BACK;
    }

    if (answer === "y" || answer === "yes") {
      return true;
    }

    if (answer === "n" || answer === "no") {
      return false;
    }

    console.log("Error: enter y, n, b, or q.");
  }
}

async function showInfoScreen(
  rl,
  title,
  lines,
  actions = [{ key: "1", label: "Continue", value: "continue" }],
  { allowBack = false } = {}
) {
  let error = "";

  for (;;) {
    clearScreen();
    console.log(divider(title));
    for (const line of lines) {
      console.log(line);
    }
    renderNotices({ error });
    renderActionFooter(actions, { allowBack, allowQuit: true });

    const selection = await promptMenuChoice(rl, actions, {
      prompt: "Select action",
      allowBack,
      allowQuit: true
    });

    if (selection === BACK) {
      return BACK;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    return selection.action.value;
  }
}

function requireReadyStatus(health, actionLabel) {
  if (health.status === "ready") {
    return null;
  }

  return `Cannot ${actionLabel} while setup status is "${describeHealthStatus(health.status)}". Choose setup first.`;
}

function appendStatusMessage(existingMessage, nextMessage) {
  return [existingMessage, nextMessage].filter(Boolean).join(" ");
}

async function openLockedStartupScreen(rl, required) {
  let error = "";
  const actions = [
    { key: "1", label: "Retry unlock", value: "retry" },
    { key: "2", label: "Quit", value: "quit" }
  ];

  for (;;) {
    clearScreen();
    console.log(divider("Unlock Required"));
    console.log("Encrypted local secret files must be unlocked before the app can continue.");
    console.log(`Locked: ${required.join(", ")}`);
    renderNotices({ error });
    renderActionFooter(actions, { allowBack: false, allowQuit: true });

    const selection = await promptMenuChoice(rl, actions, {
      prompt: "Select action",
      allowBack: false,
      allowQuit: true
    });
    error = "";

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    if (selection.action.value === "quit") {
      throw new QuitAppError();
    }

    return selection.action.value;
  }
}

export async function inspectLocalSecretState({
  chainId,
  walletAddress,
  baseDir,
  passphrase = defaultPassphrase()
}) {
  const keyringEnvelope = await readJsonFileIfExists(getKeyringPath({ chainId, walletAddress, baseDir }));
  const hubEnvelope = await readJsonFileIfExists(getHubPath({ chainId, walletAddress, baseDir }));
  const envelopes = [keyringEnvelope, hubEnvelope].filter(Boolean);
  const encryptedEnvelopes = envelopes.filter((value) => isEncryptedSecretEnvelope(value));

  if (envelopes.length === 0) {
    return {
      status: "not-initialized",
      encryptedFiles: [],
      hasPlaintextFiles: false
    };
  }

  if (encryptedEnvelopes.length === 0) {
    return {
      status: "plaintext",
      encryptedFiles: [],
      hasPlaintextFiles: true
    };
  }

  const encryptedFiles = [];
  if (isEncryptedSecretEnvelope(keyringEnvelope)) {
    encryptedFiles.push("chat keys");
  }
  if (isEncryptedSecretEnvelope(hubEnvelope)) {
    encryptedFiles.push("invite secrets");
  }

  if (!passphrase) {
    return {
      status: "encrypted-locked",
      encryptedFiles,
      hasPlaintextFiles: envelopes.length !== encryptedEnvelopes.length
    };
  }

  try {
    if (isEncryptedSecretEnvelope(keyringEnvelope)) {
      await readKeyring({ chainId, walletAddress, baseDir, passphrase });
    }
    if (isEncryptedSecretEnvelope(hubEnvelope)) {
      await readHubState({ chainId, walletAddress, baseDir, passphrase });
    }

    return {
      status: "encrypted-unlocked",
      encryptedFiles,
      hasPlaintextFiles: envelopes.length !== encryptedEnvelopes.length
    };
  } catch {
    return {
      status: "encrypted-locked",
      encryptedFiles,
      hasPlaintextFiles: envelopes.length !== encryptedEnvelopes.length
    };
  }
}

async function ensureSessionOptions(baseOptions, rl, { interactive }) {
  const nextOptions = {
    rpcUrl: baseOptions.rpcUrl || process.env.CHATTER_RPC_URL,
    contractAddress: baseOptions.contractAddress || process.env.CHATTER_CONTRACT_ADDRESS,
    privateKey: baseOptions.privateKey || process.env.CHATTER_PRIVATE_KEY
  };
  const promptedForConfiguration = !nextOptions.rpcUrl || !nextOptions.contractAddress || !nextOptions.privateKey;

  if (!interactive) {
    return nextOptions;
  }

  if (!nextOptions.rpcUrl) {
    nextOptions.rpcUrl = await promptLine(rl, "RPC URL", {
      defaultValue: "http://127.0.0.1:8545",
      screen: {
        title: "Setup",
        bodyLines: [
          "Step 1 of 4",
          "Enter the RPC URL for the chain you want to use."
        ]
      }
    });
  }

  if (!nextOptions.contractAddress) {
    nextOptions.contractAddress = await promptLine(rl, "Contract address", {
      validate: validateContractAddressInput,
      screen: {
        title: "Setup",
        bodyLines: [
          "Step 2 of 4",
          "Enter the deployed ChatterBlocks contract address."
        ]
      }
    });
  }

  if (!nextOptions.privateKey) {
    nextOptions.privateKey = await promptLine(rl, "Wallet private key", {
      validate: validatePrivateKeyInput,
      screen: {
        title: "Setup",
        bodyLines: [
          "Step 3 of 4",
          "Enter the wallet private key used to sign transactions."
        ]
      }
    });
  }

  if (promptedForConfiguration && !process.env.CHATTER_PASSPHRASE) {
    const passphrase = await promptLine(rl, "Passphrase", {
      allowEmpty: true,
      defaultValue: "",
      screen: {
        title: "Setup",
        bodyLines: [
          "Step 4 of 4",
          "Optional: enter a passphrase to encrypt local chat keys and invite secrets.",
          "Leave blank to keep local secret files unencrypted."
        ]
      }
    });

    if (passphrase && passphrase !== BACK) {
      process.env.CHATTER_PASSPHRASE = passphrase;
    }
  }

  return nextOptions;
}

async function ensureUnlockedLocalState(options, rl, { interactive }) {
  const { account, chainId } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const localSecretState = await inspectLocalSecretState({
    chainId,
    walletAddress
  });

  if (localSecretState.status !== "encrypted-locked") {
    return {
      unlocked: true,
      state: localSecretState,
      message:
        localSecretState.status === "encrypted-unlocked" && process.env.CHATTER_PASSPHRASE
          ? "Encrypted local secret files unlocked."
          : ""
    };
  }

  if (!interactive) {
    return {
      unlocked: false,
      state: localSecretState,
      required: localSecretState.encryptedFiles
    };
  }

  for (;;) {
    const passphrase = await promptLine(rl, "Passphrase", {
      allowEmpty: false,
      screen: {
        title: "Unlock Local State",
        bodyLines: [
          "This wallet has encrypted local secret files.",
          `Locked: ${localSecretState.encryptedFiles.join(", ")}`,
          "Enter your passphrase to unlock them before continuing."
        ],
        helpLines: [
          "Use CHATTER_PASSPHRASE or --passphrase to skip this prompt next time."
        ]
      },
      validate: async (value) => {
        try {
          if (localSecretState.encryptedFiles.includes("chat keys")) {
            await readKeyring({ chainId, walletAddress, passphrase: value });
          }
          if (localSecretState.encryptedFiles.includes("invite secrets")) {
            await readHubState({ chainId, walletAddress, passphrase: value });
          }
          return null;
        } catch (validationError) {
          return validationError?.message || "Invalid passphrase.";
        }
      }
    });

    if (passphrase === BACK) {
      return {
        unlocked: false,
        state: localSecretState,
        required: localSecretState.encryptedFiles,
        aborted: true
      };
    }

    if (passphrase) {
      process.env.CHATTER_PASSPHRASE = passphrase;
      return {
        unlocked: true,
        state: {
          ...localSecretState,
          status: "encrypted-unlocked"
        },
        message: `Unlocked ${localSecretState.encryptedFiles.join(" and ")}.`
      };
    }
  }
}

async function inspectHealth(options) {
  const { publicClient, account, chainId, contractAddress, rpcUrl } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  const localSecretState = await inspectLocalSecretState({ chainId, walletAddress });
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
    localSecretState,
    contacts,
    hubState,
    appState
  };
}

async function runSetupWizard(options, rl, { rotate = false } = {}) {
  if (rotate) {
    const result = await setupChatWorkflow(options, { rotate: true });
    return {
      health: await inspectHealth(options),
      message: `Rotated chat key to version ${result.registration.version.toString()}.`
    };
  }

  const health = await inspectHealth(options);

  if (health.status === "ready") {
    return {
      health,
      message: `Chat key ready for ${health.walletAddress}.`
    };
  }

  let message = "Skipped chat-key setup.";
  if (health.status === "missing-onchain-key") {
    const register = await confirm(
      rl,
      health.localKey
        ? "Local chat key exists but is not registered on this chain. Register it now?"
        : "No chat key is registered on this chain. Create and register one now?"
    );
    if (register === BACK) {
      return {
        health,
        message
      };
    }
    if (register) {
      const result = await setupChatWorkflow(options);
      message = result.reusedLocalKey
        ? `Registered existing local chat key as version ${result.registration.version.toString()}.`
        : `Registered chat key version ${result.registration.version.toString()}.`;
    }
  } else if (health.status === "missing-local-keyring" || health.status === "missing-local-key") {
    const rotateLocal = await confirm(
      rl,
      "An on-chain chat key exists, but the local private key is missing. Rotate the chat key now?",
      true
    );
    if (rotateLocal === BACK) {
      return {
        health,
        message
      };
    }
    if (rotateLocal) {
      const result = await setupChatWorkflow(options, { rotate: true });
      message = `Rotated chat key to version ${result.registration.version.toString()}.`;
    }
  } else if (health.status === "key-mismatch") {
    const rotateMismatch = await confirm(
      rl,
      "Local key is out of sync with the chain. Rotate the chat key now?"
    );
    if (rotateMismatch === BACK) {
      return {
        health,
        message
      };
    }
    if (rotateMismatch) {
      const result = await setupChatWorkflow(options, { rotate: true });
      message = `Rotated chat key to version ${result.registration.version.toString()}.`;
    }
  }

  return {
    health: await inspectHealth(options),
    message
  };
}

async function buildConversationSummaries(options, { matchesData, contacts, appState }) {
  const { publicClient, account, chainId, contractAddress } = await createConnections(options);
  const viewerAddress = getAddress(account.address);
  const keyring = await loadKeyringOrThrow({ chainId, walletAddress: viewerAddress });
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
  const inboxRecordsByPeer = new Map();
  const latestInboxRecordByPeer = new Map();

  for (const record of inboxRecords) {
    const peerAddress = getAddress(
      record.header.sender.toLowerCase() === viewerAddress.toLowerCase()
        ? record.header.recipient
        : record.header.sender
    ).toLowerCase();

    if (!inboxRecordsByPeer.has(peerAddress)) {
      inboxRecordsByPeer.set(peerAddress, []);
    }
    inboxRecordsByPeer.get(peerAddress).push(record);

    if (!latestInboxRecordByPeer.has(peerAddress)) {
      latestInboxRecordByPeer.set(peerAddress, record);
    }
  }
  const summaries = [];

  for (const peerWalletAddress of peerSet) {
    const peerAddress = getAddress(peerWalletAddress);
    const peerKey = peerAddress.toLowerCase();
    const inboxPeerRecords = inboxRecordsByPeer.get(peerKey) ?? [];
    let lastRecord = latestInboxRecordByPeer.get(peerKey) ?? null;

    if (!lastRecord) {
      const conversationId = await getConversationId(publicClient, contractAddress, viewerAddress, peerAddress);
      const messageIds = await getConversationPage(publicClient, contractAddress, conversationId, 0n, 1n);
      const records = messageIds.length === 0
        ? []
        : await hydrateMessages({
          publicClient,
          contractAddress,
          viewerAddress,
          keyring,
          messageIds
        });
      lastRecord = records.at(-1) ?? null;
    }
    const contact = getContact(contacts, peerAddress);

    summaries.push({
      peerAddress,
      contact,
      lastRecord,
      unreadCount: getUnreadCount({
        appState,
        peerWalletAddress: peerAddress,
        records: inboxPeerRecords
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

async function renderHome(options) {
  const health = await inspectHealth(options);

  if (health.status !== "ready") {
    return {
      health,
      summaries: [],
      matches: { matches: [] },
      activeInvites: { entries: [] }
    };
  }

  const matches = await listInviteMatchesWorkflow(options);
  const summaries = await buildConversationSummaries(options, {
    matchesData: matches,
    contacts: health.contacts,
    appState: health.appState
  });
  const activeInvites = await listActiveInvitesWorkflow(options, { cursor: 0n, limit: 8 });

  return {
    health,
    summaries,
    matches,
    activeInvites
  };
}

export function buildConversationActions(summaries, { startKey = 7 } = {}) {
  return summaries.slice(0, 5).map((summary, index) => ({
    key: String(startKey + index),
    label: `Open ${summary.contact?.alias ?? summary.peerAddress}`,
    value: {
      type: "conversation",
      peerAddress: summary.peerAddress
    }
  }));
}

export function buildContactsActions(contactsList, { startKey = 5 } = {}) {
  return contactsList.slice(0, 8).map((contact, index) => ({
    key: String(startKey + index),
    label: `Open ${contact.alias ?? contact.address}`,
    value: {
      type: "open-contact",
      reference: contact.address
    }
  }));
}

function renderConversationList({ summaries, contacts, showExactTimestamps, startIndex = 1 }) {
  if (summaries.length === 0) {
    console.log("No conversations yet.");
    return;
  }

  for (const [index, summary] of summaries.slice(0, 5).entries()) {
    const unread = summary.unreadCount > 0 ? ` unread=${summary.unreadCount}` : "";
    const draft = summary.draft ? " draft" : "";
    console.log(
      `${formatContactLabel(contacts, summary.peerAddress)}${summary.verified ? " verified" : ""}${unread}${draft}`
    );
    console.log(`   ${conversationPreview(summary.lastRecord)} · ${messageTimestamp(summary.lastRecord, showExactTimestamps)}`);
  }
}

async function openConversationScreen(rl, options, peerReference, { backTarget = null } = {}) {
  let notice = "";
  let error = "";
  let cachedContactInfo = null;

  for (;;) {
    const thread = await readInboxWorkflow(options, {
      peerReference,
      cursor: 0n,
      limit: 25
    });
    const health = await inspectHealth(options);
    const appState = health.appState;
    const contactInfo = cachedContactInfo ?? await showContactWorkflow(options, { reference: thread.peerAddress });
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
    console.log(`Draft: ${currentDraft ? currentDraft : "(empty)"}`);
    renderNotices({ notice, error });

    const actions = [
      { key: "1", label: "Edit draft", value: "edit-draft" },
      { key: "2", label: "Send message", value: "send-message" },
      { key: "3", label: "Save contact", value: "save-contact" },
      { key: "4", label: "Verify contact", value: "verify-contact" },
      { key: "5", label: "Refresh", value: "refresh" }
    ];
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return backTarget;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    if (selection.action.value === "refresh") {
      continue;
    }

    if (selection.action.value === "edit-draft") {
      const draft = await promptLine(rl, "Draft text", {
        allowEmpty: true,
        defaultValue: currentDraft,
        screen: {
          title: "Edit Draft",
          bodyLines: [
            `Peer: ${formatContactLabel(thread.contacts, thread.peerAddress)}`,
            "Enter the message draft for this conversation."
          ]
        }
      });
      if (draft === BACK) {
        continue;
      }

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
      notice = "Draft updated.";
      continue;
    }

    if (selection.action.value === "send-message") {
      const text = currentDraft || (await promptLine(rl, "Message text", {
        screen: {
          title: "Send Message",
          bodyLines: [
            `Peer: ${formatContactLabel(thread.contacts, thread.peerAddress)}`,
            "Enter the message to encrypt and send."
          ]
        }
      }));
      if (text === BACK) {
        continue;
      }

      try {
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
        notice = `Sent message ${sent.sentMessage.messageId.toString()}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (selection.action.value === "save-contact") {
      const existingContact = contactInfo.contact;
      const alias = await promptLine(rl, "Alias", {
        allowEmpty: true,
        defaultValue: existingContact?.alias ?? "",
        validate: (value) => validateContactAlias(value, { allowEmpty: true }),
        screen: {
          title: "Save Contact",
          bodyLines: [
            `Peer: ${thread.peerAddress}`,
            "Optional: add a local alias for this contact."
          ]
        }
      });
      if (alias === BACK) {
        continue;
      }

      const notes = await promptLine(rl, "Notes", {
        allowEmpty: true,
        defaultValue: existingContact?.notes ?? "",
        screen: {
          title: "Save Contact",
          bodyLines: [
            `Peer: ${thread.peerAddress}`,
            `Alias: ${alias || "(none)"}`,
            "Optional: add local notes for this contact."
          ]
        }
      });
      if (notes === BACK) {
        continue;
      }

      try {
        await saveContactWorkflow(options, {
          address: thread.peerAddress,
          alias,
          notes,
          chainLabel: String(health.chainId)
        });
        cachedContactInfo = null;
        notice = "Contact saved.";
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (selection.action.value === "verify-contact") {
      try {
        const result = await verifyContactWorkflow(options, { reference: thread.peerAddress });
        cachedContactInfo = null;
        notice = `Verified ${result.contact.alias ?? result.contact.address}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
    }
  }
}

function getPosterInvites(hubState) {
  return Object.values(hubState?.invites ?? {})
    .filter((invite) => invite.role === "poster")
    .sort((left, right) => Number(right.inviteId) - Number(left.inviteId));
}

function getActivePosterInvites(hubState) {
  return getPosterInvites(hubState).filter((invite) => invite.status === "ACTIVE");
}

async function showInviteBundleScreen(rl, inviteRecord) {
  const shareCode = encodeInviteShareCode({
    inviteId: inviteRecord.inviteId,
    inviteSecret: inviteRecord.inviteSecret,
    phraseA: inviteRecord.phraseA,
    phraseB: inviteRecord.phraseB
  });

  return await showInfoScreen(rl, `Invite #${inviteRecord.inviteId}`, [
    `Status: ${inviteRecord.status}`,
    `Expires: ${inviteRecord.expiresAt ? new Date(Number(inviteRecord.expiresAt) * 1000).toISOString() : "unknown"}`,
    "",
    "Share privately:",
    formatCopyBlock("inviteId", String(inviteRecord.inviteId)),
    formatCopyBlock("inviteSecret", inviteRecord.inviteSecret ?? "missing"),
    formatCopyBlock("phraseA", inviteRecord.phraseA ?? "missing"),
    formatCopyBlock("phraseB", inviteRecord.phraseB ?? "missing"),
    formatCopyBlock("shareCode", shareCode),
    "",
    "Next step: the responder uses the share code or the raw fields to submit an encrypted response."
  ], [{ key: "1", label: "Continue", value: "continue" }], { allowBack: true });
}

async function promptInvitePost(rl, options) {
  const phraseA = await promptLine(rl, "Phrase A", {
    screen: {
      title: "Post Invite",
      bodyLines: [
        "Create a share bundle for a responder.",
        "Step 1 of 3: enter phrase A."
      ]
    }
  });
  if (phraseA === BACK) {
    return BACK;
  }

  const phraseB = await promptLine(rl, "Phrase B", {
    screen: {
      title: "Post Invite",
      bodyLines: [
        `Phrase A: ${phraseA}`,
        "Step 2 of 3: enter the reciprocal phrase B."
      ]
    }
  });
  if (phraseB === BACK) {
    return BACK;
  }

  const ttlHours = await promptLine(rl, "TTL hours", {
    defaultValue: "24",
    screen: {
      title: "Post Invite",
      bodyLines: [
        `Phrase A: ${phraseA}`,
        `Phrase B: ${phraseB}`,
        "Step 3 of 3: choose how long the invite should stay active."
      ]
    },
    validate: (value) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 24 * 7) {
        return "TTL must be an integer number of hours between 1 and 168.";
      }

      return null;
    }
  });
  if (ttlHours === BACK) {
    return BACK;
  }

  const posted = await postInviteWorkflow(options, {
    phraseA,
    phraseB,
    ttlHours
  });

  return {
    ...posted,
    phraseA,
    phraseB
  };
}

async function promptInviteResponse(rl, options) {
  const shareCode = await promptLine(rl, "Share code", {
    screen: {
      title: "Respond To Invite",
      bodyLines: [
        "Paste the full shareCode from the poster.",
        "The bundle is validated locally before the encrypted response is submitted."
      ]
    },
    validate: (value) => {
      try {
        decodeInviteShareCode(value);
        return null;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (shareCode === BACK) {
    return BACK;
  }

  const bundle = decodeInviteShareCode(shareCode);
  return respondInviteWorkflow(options, {
    inviteId: bundle.inviteId,
    inviteSecret: bundle.inviteSecret,
    phraseA: bundle.phraseA,
    phraseB: bundle.phraseB
  });
}

async function chooseInviteFromList(rl, title, invites, emptyMessage) {
  let error = "";

  for (;;) {
    clearScreen();
    console.log(divider(title));

    if (invites.length === 0) {
      console.log(emptyMessage);
    } else {
      for (const [index, invite] of invites.entries()) {
        console.log(
          `${index + 1}. #${invite.inviteId} ${invite.status} expires=` +
          `${invite.expiresAt ? new Date(Number(invite.expiresAt) * 1000).toISOString() : "unknown"}`
        );
      }
    }

    renderNotices({ error });
    const actions = invites.map((invite, index) => ({
      key: String(index + 1),
      label: `Select invite #${invite.inviteId}`,
      value: invite
    }));
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select invite" });
    error = "";

    if (selection === BACK) {
      return BACK;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    return selection.action.value;
  }
}

async function openInviteReviewScreen(rl, options, health) {
  const selectedInvite = await chooseInviteFromList(
    rl,
    "Review Invite Responses",
    getPosterInvites(health.hubState),
    "No local invite records."
  );

  if (selectedInvite === BACK) {
    return null;
  }

  let error = "";
  let notice = "";

  for (;;) {
    const review = await reviewInviteResponsesWorkflow(options, { inviteId: selectedInvite.inviteId });
    clearScreen();
    console.log(divider(`Responses for Invite #${selectedInvite.inviteId}`));
    console.log(`Poster: ${review.invite.poster}`);
    console.log(`Expires: ${new Date(Number(review.invite.expiresAt) * 1000).toISOString()}`);

    const validResponses = [];
    if (review.responses.length === 0) {
      console.log("No invite responses yet.");
    } else {
      for (const [index, response] of review.responses.entries()) {
        const state = response.validation.valid
          ? "valid"
          : `invalid (${response.validation.errors.join(", ")})`;
        console.log(
          `${index + 1}. responseId=${response.responseId.toString()} responder=${response.header.responder} ${state}`
        );
        if (response.validation.valid) {
          validResponses.push(response);
        }
      }
    }

    renderNotices({ notice, error });
    const actions = [];
    let nextKey = 1;
    for (const response of validResponses) {
      actions.push({
        key: String(nextKey++),
        label: `Accept response ${response.responseId.toString()}`,
        value: response
      });
    }
    actions.push({
      key: String(nextKey++),
      label: "Refresh responses",
      value: "refresh"
    });
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return null;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    if (selection.action.value === "refresh") {
      notice = "Responses refreshed.";
      continue;
    }

    const response = selection.action.value;
    const contacts = await readContacts({
      chainId: health.chainId,
      walletAddress: health.walletAddress
    });
    const responderContact = getContact(contacts, response.header.responder);

    if (!responderContact?.verified) {
      const shouldAccept = await confirm(
        rl,
        `Responder ${response.header.responder} is not verified locally. Accept anyway?`,
        false
      );
      if (shouldAccept === BACK) {
        notice = "Acceptance cancelled.";
        continue;
      }
      if (!shouldAccept) {
        notice = "Acceptance cancelled.";
        continue;
      }
    }

    try {
      const accepted = await acceptInviteResponseWorkflow(options, {
        inviteId: selectedInvite.inviteId,
        responseId: response.responseId
      });
      const nextAction = await showInfoScreen(rl, "Match Accepted", [
        `Peer wallet: ${accepted.acceptedMatch.responder}`,
        `Peer key version: ${accepted.matchRecord.responderKeyVersion.toString()}`,
        `Fingerprint: ${accepted.contactUpdate.fingerprint}`,
        `Contacts file: ${accepted.contactUpdate.contactsPath}`
      ], [
        { key: "1", label: "Open conversation", value: "open-conversation" },
        { key: "2", label: "Back to home", value: "back-to-home" }
      ], { allowBack: true });

      if (nextAction === BACK || nextAction === "back-to-home") {
        return ROUTE_HOME;
      }
      if (nextAction === "open-conversation") {
        return {
          type: "conversation",
          peerAddress: accepted.acceptedMatch.responder,
          backTarget: ROUTE_HOME
        };
      }
    } catch (workflowError) {
      error = workflowError?.message || String(workflowError);
    }
  }
}

async function openMatchesScreen(rl, options) {
  let error = "";

  for (;;) {
    const matches = await listInviteMatchesWorkflow(options);
    clearScreen();
    console.log(divider("Matches"));

    if (matches.matches.length === 0) {
      console.log("No matches.");
    } else {
      for (const [index, entry] of matches.matches.entries()) {
        console.log(
          `${index + 1}. ${formatContactLabel(matches.contacts, entry.peer.peerWalletAddress)} ` +
          `matched=${new Date(Number(entry.matchRecord.matchedAt) * 1000).toISOString()}`
        );
      }
    }

    renderNotices({ error });
    const actions = matches.matches.map((entry, index) => ({
      key: String(index + 1),
      label: `Open ${formatContactLabel(matches.contacts, entry.peer.peerWalletAddress)}`,
      value: entry.peer.peerWalletAddress
    }));
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    error = "";

    if (selection === BACK) {
      return;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    const nextRoute = await openConversationScreen(rl, options, selection.action.value);
    if (nextRoute === ROUTE_HOME) {
      return ROUTE_HOME;
    }
  }
}

async function openHubScreen(rl, options) {
  let notice = "";
  let error = "";

  for (;;) {
    const health = await inspectHealth(options);
    const blocked = requireReadyStatus(health, "use the hub");
    const activeInvites = blocked
      ? { entries: [] }
      : await listActiveInvitesWorkflow(options, { cursor: 0n, limit: 8 });
    const matches = blocked
      ? { matches: [] }
      : await listInviteMatchesWorkflow(options);
    const myInvites = getPosterInvites(health.hubState);

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
        console.log(
          `#${entry.inviteId.toString()} poster=${entry.invite.poster} ` +
          `expires=${new Date(Number(entry.invite.expiresAt) * 1000).toISOString()}`
        );
      }
    }
    console.log(divider("Your Invites"));
    if (myInvites.length === 0) {
      console.log("No local invite records.");
    } else {
      for (const invite of myInvites.slice(0, 5)) {
        console.log(
          `#${invite.inviteId} ${invite.status} expires=` +
          `${invite.expiresAt ? new Date(Number(invite.expiresAt) * 1000).toISOString() : "unknown"}`
        );
      }
    }

    renderNotices({ notice, error: error || blocked });
    const actions = [
      { key: "1", label: "Post invite", value: "post" },
      { key: "2", label: "Respond with share code", value: "respond" },
      { key: "3", label: "Review responses", value: "review" },
      { key: "4", label: "View matches", value: "matches" },
      { key: "5", label: "Cancel invite", value: "cancel" },
      { key: "6", label: "Show latest share bundle", value: "show-share-bundle" },
      { key: "7", label: "Refresh", value: "refresh" }
    ];
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    if (selection.action.value === "refresh") {
      notice = "Hub refreshed.";
      continue;
    }

    if (blocked) {
      error = blocked;
      continue;
    }

    if (selection.action.value === "post") {
      try {
        const posted = await promptInvitePost(rl, options);
        if (posted === BACK) {
          continue;
        }

        const shareBundle = decodeInviteShareCode(posted.shareCode);
        const bundleAction = await showInviteBundleScreen(rl, {
          inviteId: shareBundle.inviteId,
          inviteSecret: shareBundle.inviteSecret,
          phraseA: shareBundle.phraseA,
          phraseB: shareBundle.phraseB,
          expiresAt: posted.inviteDetails.expiresAt,
          status: "ACTIVE"
        });
        if (bundleAction === BACK) {
          notice = "Returned from share bundle.";
          continue;
        }
        notice = `Invite ${posted.postedInvite.inviteId.toString()} posted.`;

        // Reload hub state so "show latest share bundle" has the current local record.
        continue;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
        continue;
      }
    }

    if (selection.action.value === "respond") {
      try {
        const response = await promptInviteResponse(rl, options);
        if (response === BACK) {
          continue;
        }

        const infoAction = await showInfoScreen(rl, "Invite Response Submitted", [
          `Invite: ${response.inviteDetails.poster}`,
          `Response ID: ${response.submittedResponse.responseId.toString()}`,
          `Poster wallet: ${response.inviteDetails.poster}`,
          `Poster invite-time key version: ${response.inviteDetails.posterKeyVersion.toString()}`
        ], [{ key: "1", label: "Continue", value: "continue" }], { allowBack: true });
        if (infoAction === BACK) {
          notice = "Returned from response summary.";
          continue;
        }
        notice = `Submitted response ${response.submittedResponse.responseId.toString()}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (selection.action.value === "review") {
      const reviewResult = await openInviteReviewScreen(rl, options, health);
      if (reviewResult === ROUTE_HOME) {
        return ROUTE_HOME;
      }
      if (reviewResult?.type === "conversation") {
        const nextRoute = await openConversationScreen(
          rl,
          options,
          reviewResult.peerAddress,
          { backTarget: reviewResult.backTarget ?? null }
        );
        if (nextRoute === ROUTE_HOME) {
          return ROUTE_HOME;
        }
      }
      notice = "Returned from invite review.";
      continue;
    }

    if (selection.action.value === "matches") {
      const nextRoute = await openMatchesScreen(rl, options);
      if (nextRoute === ROUTE_HOME) {
        return ROUTE_HOME;
      }
      continue;
    }

    if (selection.action.value === "cancel") {
      const invite = await chooseInviteFromList(
        rl,
        "Cancel Invite",
        getActivePosterInvites(health.hubState),
        "No active posted invites."
      );
      if (invite === BACK) {
        continue;
      }

      const shouldCancel = await confirm(rl, `Cancel invite #${invite.inviteId}?`, false);
      if (shouldCancel === BACK) {
        notice = "Cancellation cancelled.";
        continue;
      }
      if (!shouldCancel) {
        notice = "Cancellation skipped.";
        continue;
      }

      try {
        await cancelInviteWorkflow(options, { inviteId: invite.inviteId });
        notice = `Cancelled invite ${invite.inviteId}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (selection.action.value === "show-share-bundle") {
      const latestInvite = getPosterInvites(await readHubState({
        chainId: health.chainId,
        walletAddress: health.walletAddress
      })).find((invite) => invite.inviteSecret && invite.phraseA && invite.phraseB);

      if (!latestInvite) {
        error = "No local posted invite with a stored share bundle was found.";
        continue;
      }

      const bundleAction = await showInviteBundleScreen(rl, latestInvite);
      if (bundleAction === BACK) {
        notice = "Returned from share bundle.";
      }
    }
  }
}

async function openContactDetailScreen(rl, options, reference) {
  let notice = "";
  let error = "";

  for (;;) {
    const contact = await showContactWorkflow(options, { reference });
    clearScreen();
    console.log(divider("Contact Details"));
    console.log(`Address: ${contact.peerAddress}`);
    console.log(`Alias: ${contact.contact?.alias ?? "(none)"}`);
    console.log(`Notes: ${contact.contact?.notes ?? "(none)"}`);
    console.log(`Verified: ${contact.contact?.verified ? "yes" : "no"}`);
    console.log(`Fingerprint: ${contact.fingerprint}`);

    renderNotices({ notice, error });
    const actions = [
      { key: "1", label: "Edit contact", value: "edit" },
      { key: "2", label: "Verify fingerprint", value: "verify" },
      { key: "3", label: "Open conversation", value: "conversation" }
    ];
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

    if (selection.action.value === "edit") {
      const alias = await promptLine(rl, "Alias", {
        allowEmpty: true,
        defaultValue: contact.contact?.alias ?? "",
        validate: (value) => validateContactAlias(value, { allowEmpty: true }),
        screen: {
          title: "Edit Contact",
          bodyLines: [
            `Address: ${contact.peerAddress}`,
            "Optional: update the local alias for this contact."
          ]
        }
      });
      if (alias === BACK) {
        continue;
      }

      const notes = await promptLine(rl, "Notes", {
        allowEmpty: true,
        defaultValue: contact.contact?.notes ?? "",
        screen: {
          title: "Edit Contact",
          bodyLines: [
            `Address: ${contact.peerAddress}`,
            `Alias: ${alias || "(none)"}`,
            "Optional: update local notes for this contact."
          ]
        }
      });
      if (notes === BACK) {
        continue;
      }

      try {
        await saveContactWorkflow(options, {
          address: contact.peerAddress,
          alias,
          notes
        });
        notice = "Contact saved.";
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (selection.action.value === "verify") {
      try {
        const result = await verifyContactWorkflow(options, { reference: contact.peerAddress });
        notice = `Verified fingerprint ${formatChatKeyFingerprint(result.activeChatKey.pubKey)}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    await openConversationScreen(rl, options, contact.peerAddress);
  }
}

async function openContactsScreen(rl, options) {
  let notice = "";
  let error = "";

  for (;;) {
    const contactsData = await listContactsWorkflow(options);
    clearScreen();
    console.log(divider("Contacts"));
    console.log(divider("Saved Contacts"));

    if (contactsData.list.length === 0) {
      console.log("No contacts saved.");
    } else {
      for (const contact of contactsData.list.slice(0, 8)) {
        console.log(
          `${contact.alias ?? contact.address} ` +
          `${contact.verified ? "verified" : "unverified"} ` +
          `${contact.fingerprint ? `fingerprint=${contact.fingerprint}` : ""}`
        );
      }
    }

    renderNotices({ notice, error });
    const actions = [
      { key: "1", label: "Add contact", value: { type: "add-contact" } },
      { key: "2", label: "Export contacts", value: { type: "export-contacts" } },
      { key: "3", label: "Import contacts", value: { type: "import-contacts" } },
      { key: "4", label: "Refresh", value: { type: "refresh" } }
    ];
    const contactActions = buildContactsActions(contactsData.list, { startKey: 5 });
    const allActions = [...actions, ...contactActions];
    renderActionFooter(allActions);

    const selection = await promptMenuChoice(rl, allActions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

      const action = selection.action.value;
    if (action.type === "open-contact") {
      await openContactDetailScreen(rl, options, action.reference);
      continue;
    }

    if (action.type === "refresh") {
      notice = "Contacts refreshed.";
      continue;
    }

    if (action.type === "add-contact") {
      const address = await promptLine(rl, "Address", {
        screen: {
          title: "Add Contact",
          bodyLines: [
            "Enter the peer wallet address to save locally."
          ]
        },
        validate: (value) => validateWalletAddressInput(value)
      });
      if (address === BACK) {
        continue;
      }

      const alias = await promptLine(rl, "Alias", {
        allowEmpty: true,
        screen: {
          title: "Add Contact",
          bodyLines: [
            `Address: ${address}`,
            "Optional: add a short alias for this wallet."
          ]
        },
        validate: (value) => validateContactAlias(value, { allowEmpty: true })
      });
      if (alias === BACK) {
        continue;
      }

      const notes = await promptLine(rl, "Notes", {
        allowEmpty: true,
        screen: {
          title: "Add Contact",
          bodyLines: [
            `Address: ${address}`,
            `Alias: ${alias || "(none)"}`,
            "Optional: add local notes for this contact."
          ]
        }
      });
      if (notes === BACK) {
        continue;
      }

      try {
        await saveContactWorkflow(options, {
          address,
          alias,
          notes
        });
        notice = "Contact saved.";
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (action.type === "export-contacts") {
      const filePath = await promptLine(rl, "Export path", {
        screen: {
          title: "Export Contacts",
          bodyLines: [
            "Enter the JSON file path to write your local contacts export."
          ]
        },
        validate: validateExportFilePath
      });
      if (filePath === BACK) {
        continue;
      }

      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(filePath, `${JSON.stringify(contactsData.contacts ?? {
          schemaVersion: 1,
          chainId: contactsData.chainId,
          walletAddress: contactsData.walletAddress,
          contacts: {}
        }, null, 2)}\n`);
        notice = `Exported contacts to ${filePath}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
      continue;
    }

    if (action.type === "import-contacts") {
      const filePath = await promptLine(rl, "Import path", {
        screen: {
          title: "Import Contacts",
          bodyLines: [
            "Enter the JSON file path to import and merge."
          ]
        },
        validate: validateImportFilePath
      });
      if (filePath === BACK) {
        continue;
      }

      try {
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
        notice = `Imported contacts from ${filePath}.`;
      } catch (workflowError) {
        error = workflowError?.message || String(workflowError);
      }
    }
  }
}

async function openSettingsScreen(rl, options) {
  const { account, chainId } = await createConnections(options);
  const walletAddress = getAddress(account.address);
  let notice = "";
  let error = "";

  for (;;) {
    const appState = await readAppState({ chainId, walletAddress });
    const settings = appState?.settings ?? { showExactTimestamps: false };

    clearScreen();
    console.log(divider("Settings"));
    console.log(`Exact timestamps: ${settings.showExactTimestamps ? "on" : "off"}`);

    renderNotices({ notice, error });
    const actions = [
      { key: "1", label: "Toggle timestamps", value: "toggle-timestamps" }
    ];
    renderActionFooter(actions);

    const selection = await promptMenuChoice(rl, actions, { prompt: "Select action" });
    notice = "";
    error = "";

    if (selection === BACK) {
      return;
    }

    if (selection.type === "invalid") {
      error = selection.error;
      continue;
    }

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
    notice = `Exact timestamps turned ${!settings.showExactTimestamps ? "on" : "off"}.`;
  }
}

export async function launchChatApp(baseOptions, { runWizard = false, rotate = false } = {}) {
  const rl = createInterface({ input, output });
  let options;
  let wizardMessage = "";
  let homeError = "";

  try {
    options = await ensureSessionOptions(baseOptions, rl, { interactive: runWizard });
    for (;;) {
      const unlockState = await ensureUnlockedLocalState(options, rl, { interactive: true });
      if (unlockState.unlocked) {
        wizardMessage = appendStatusMessage(wizardMessage, unlockState.message);
        break;
      }

      const nextAction = await openLockedStartupScreen(rl, unlockState.required);
      if (nextAction === "retry") {
        continue;
      }
    }

    if (runWizard) {
      clearScreen();
      console.log(divider("Welcome To ChatterBlocks"));
      console.log("This client keeps message contents encrypted, but wallet activity stays public on-chain.");
      const wizardResult = await runSetupWizard(options, rl, { rotate });
      wizardMessage = appendStatusMessage(wizardMessage, wizardResult.message);
    }

    for (;;) {
      const home = await renderHome(options);
      clearScreen();
      console.log(divider("ChatterBlocks App"));
      console.log(`Wallet: ${home.health.walletAddress}`);
      console.log(`Chain: ${home.health.chainId}`);
      console.log(`RPC: ${home.health.rpcUrl}`);
      console.log(`Contract: ${home.health.contractAddress}`);
      console.log(`Status: ${describeHealthStatus(home.health.status)}`);
      console.log(`Local secrets: ${formatLocalSecretStateLabel(home.health.localSecretState.status)}`);
      if (wizardMessage) {
        console.log(`Last action: ${wizardMessage}`);
      }
      console.log(divider("Conversations"));
      renderConversationList({
        summaries: home.summaries,
        contacts: home.health.contacts,
        showExactTimestamps: home.health.appState?.settings?.showExactTimestamps ?? false
      });
      console.log(divider("Hub & Contacts"));
      console.log(`Matches: ${home.matches.matches.length}`);
      console.log(`Public invites: ${home.activeInvites.entries.length}`);
      console.log(`Saved contacts: ${listContacts(home.health.contacts).length}`);

      renderNotices({ notice: wizardMessage, error: homeError });
      const primaryActions = [
        { key: "1", label: "Hub", value: "hub" },
        { key: "2", label: "Contacts", value: "contacts" },
        { key: "3", label: "Settings", value: "settings" },
        { key: "4", label: "New conversation", value: "new-conversation" },
        { key: "5", label: "Run setup", value: "setup" },
        { key: "6", label: "Refresh", value: "refresh" }
      ];
      const conversationActions = buildConversationActions(home.summaries, { startKey: 7 });
      const allActions = [...primaryActions, ...conversationActions];
      renderActionFooter(allActions, { allowBack: false, allowQuit: true });

      const selection = await promptMenuChoice(rl, allActions, {
        prompt: "Select action",
        allowBack: false,
        allowQuit: true
      });
      homeError = "";

      if (selection === BACK) {
        continue;
      }

      if (selection.type === "invalid") {
        homeError = selection.error;
        continue;
      }

      const choice = selection.action.value;
      if (typeof choice === "object" && choice.type === "conversation") {
        await openConversationScreen(rl, options, choice.peerAddress);
        wizardMessage = "";
        continue;
      }

      if (choice === "refresh") {
        wizardMessage = "Home refreshed.";
        continue;
      }

      if (choice === "new-conversation") {
        const reference = await promptLine(rl, "Address or alias", {
          screen: {
            title: "New Conversation",
            bodyLines: [
              "Enter a saved alias or a peer wallet address."
            ]
          },
          validate: validateConversationReferenceInput
        });
        if (reference === BACK) {
          continue;
        }

        try {
          await openConversationScreen(rl, options, reference);
          wizardMessage = "";
        } catch (workflowError) {
          homeError = workflowError?.message || String(workflowError);
        }
        continue;
      }

      if (choice === "hub") {
        const nextRoute = await openHubScreen(rl, options);
        wizardMessage = "";
        if (nextRoute === ROUTE_HOME) {
          continue;
        }
        continue;
      }

      if (choice === "contacts") {
        await openContactsScreen(rl, options);
        wizardMessage = "";
        continue;
      }

      if (choice === "settings") {
        await openSettingsScreen(rl, options);
        wizardMessage = "";
        continue;
      }

      const wizardResult = await runSetupWizard(options, rl);
      wizardMessage = wizardResult.message || "Health check complete.";
    }
  } catch (error) {
    if (!(error instanceof QuitAppError)) {
      throw error;
    }
  } finally {
    rl.close();
  }
}

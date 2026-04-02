import path from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { getAddress } from "viem";

import { createWalletContext } from "./config.js";
import { getHubPath, readHubState } from "./hub.js";
import { getKeyringPath, getWalletStateDir, readKeyring } from "./keyring.js";
import { defaultPassphrase, isEncryptedSecretEnvelope } from "./secret-store.js";

export const SECRET_EXPORT_SCHEMA_VERSION = 1;

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

function storageLabel(rawValue) {
  if (rawValue === null) {
    return "missing";
  }

  return isEncryptedSecretEnvelope(rawValue) ? "encrypted" : "plaintext";
}

function validateSecretExportShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Secret backup file is malformed. Expected a JSON object.");
  }

  const requiredFields = ["schemaVersion", "chainId", "walletAddress", "exportedAt", "keyring", "hubState"];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Secret backup file is malformed. Missing required field: ${field}.`);
    }
  }

  if (Number(parsed.schemaVersion) !== SECRET_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `Secret backup file schema ${String(parsed.schemaVersion)} is not supported.`
    );
  }

  if (parsed.keyring !== null && (typeof parsed.keyring !== "object" || Array.isArray(parsed.keyring))) {
    throw new Error("Secret backup file is malformed. `keyring` must be an object or null.");
  }

  if (parsed.hubState !== null && (typeof parsed.hubState !== "object" || Array.isArray(parsed.hubState))) {
    throw new Error("Secret backup file is malformed. `hubState` must be an object or null.");
  }

  return parsed;
}

async function writeSecretFileAtomically(filePath, payload) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

function normalizeWalletAddress(value) {
  return getAddress(value).toLowerCase();
}

async function resolveSecretSession(options) {
  if (options?.chainId !== undefined && options?.walletAddress) {
    return {
      chainId: String(options.chainId),
      walletAddress: normalizeWalletAddress(options.walletAddress)
    };
  }

  const { account, chainId } = await createWalletContext(options);
  return {
    chainId: String(chainId),
    walletAddress: normalizeWalletAddress(account.address)
  };
}

export async function inspectSecretState(options = {}) {
  const {
    baseDir,
    passphrase = defaultPassphrase()
  } = options;
  const { chainId, walletAddress: normalizedWalletAddress } = await resolveSecretSession(options);
  const stateDir = getWalletStateDir({ chainId, walletAddress: normalizedWalletAddress, baseDir });
  const keyringPath = getKeyringPath({ chainId, walletAddress: normalizedWalletAddress, baseDir });
  const hubPath = getHubPath({ chainId, walletAddress: normalizedWalletAddress, baseDir });
  const rawKeyring = await readJsonFileIfExists(keyringPath);
  const rawHubState = await readJsonFileIfExists(hubPath);

  const details = {
    stateDir,
    chainId: String(chainId),
    walletAddress: normalizedWalletAddress,
    passphraseActive: Boolean(passphrase),
    keyring: {
      filePath: keyringPath,
      exists: rawKeyring !== null,
      storage: storageLabel(rawKeyring),
      activeKeyVersion: null,
      historicalKeyCount: null,
      readable: false,
      error: null
    },
    hubState: {
      filePath: hubPath,
      exists: rawHubState !== null,
      storage: storageLabel(rawHubState),
      inviteCount: null,
      readable: false,
      error: null
    }
  };

  if (rawKeyring !== null) {
    try {
      const keyring = await readKeyring({
        chainId,
        walletAddress: normalizedWalletAddress,
        baseDir,
        passphrase
      });
      details.keyring.readable = true;
      details.keyring.activeKeyVersion = keyring?.activeVersion ?? null;
      details.keyring.historicalKeyCount = Object.keys(keyring?.keys ?? {}).length;
    } catch (error) {
      details.keyring.error = error?.message || String(error);
    }
  }

  if (rawHubState !== null) {
    try {
      const hubState = await readHubState({
        chainId,
        walletAddress: normalizedWalletAddress,
        baseDir,
        passphrase
      });
      details.hubState.readable = true;
      details.hubState.inviteCount = Object.keys(hubState?.invites ?? {}).length;
    } catch (error) {
      details.hubState.error = error?.message || String(error);
    }
  }

  return details;
}

export async function exportSecretState(options, { filePath, baseDir, passphrase = defaultPassphrase() } = {}) {
  const { chainId, walletAddress } = await resolveSecretSession(options);
  const keyringPath = getKeyringPath({ chainId, walletAddress, baseDir });
  const hubPath = getHubPath({ chainId, walletAddress, baseDir });
  const keyring = await readJsonFileIfExists(keyringPath);
  const hubState = await readJsonFileIfExists(hubPath);
  const payload = {
    schemaVersion: SECRET_EXPORT_SCHEMA_VERSION,
    chainId: String(chainId),
    walletAddress,
    exportedAt: new Date().toISOString(),
    keyring,
    hubState
  };

  const exportDirectory = path.dirname(path.resolve(filePath));
  await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);

  return {
    filePath,
    chainId: String(chainId),
    walletAddress,
    exportedAt: payload.exportedAt,
    stateDir: getWalletStateDir({ chainId, walletAddress, baseDir }),
    passphraseActive: Boolean(passphrase),
    keyringIncluded: keyring !== null,
    hubStateIncluded: hubState !== null
  };
}

export async function importSecretState(options, { filePath, baseDir } = {}) {
  const { chainId, walletAddress } = await resolveSecretSession(options);
  const parsed = validateSecretExportShape(JSON.parse(await readFile(filePath, "utf8")));

  if (String(parsed.chainId) !== String(chainId)) {
    throw new Error(
      `Secret backup file targets chain ${String(parsed.chainId)}, but the current session is chain ${String(chainId)}.`
    );
  }

  if (normalizeWalletAddress(parsed.walletAddress) !== walletAddress) {
    throw new Error(
      `Secret backup file targets wallet ${parsed.walletAddress}, but the current session is ${walletAddress}.`
    );
  }

  const stateDir = getWalletStateDir({ chainId, walletAddress, baseDir });
  const keyringPath = getKeyringPath({ chainId, walletAddress, baseDir });
  const hubPath = getHubPath({ chainId, walletAddress, baseDir });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  if (parsed.keyring === null) {
    await rm(keyringPath, { force: true });
  } else {
    await writeSecretFileAtomically(keyringPath, parsed.keyring);
  }

  if (parsed.hubState === null) {
    await rm(hubPath, { force: true });
  } else {
    await writeSecretFileAtomically(hubPath, parsed.hubState);
  }

  return {
    filePath,
    chainId: String(chainId),
    walletAddress,
    stateDir,
    keyringPath: parsed.keyring === null ? null : keyringPath,
    hubPath: parsed.hubState === null ? null : hubPath
  };
}

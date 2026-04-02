import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

function requireValue(value, message) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

export function resolveRpcUrl(options) {
  return requireValue(
    options.rpcUrl || process.env.CHATTER_RPC_URL,
    "Missing RPC URL. Pass --rpc-url or set CHATTER_RPC_URL."
  );
}

export function resolveContractAddress(options) {
  const value = requireValue(
    options.contractAddress || process.env.CHATTER_CONTRACT_ADDRESS,
    "Missing contract address. Pass --contract-address or set CHATTER_CONTRACT_ADDRESS."
  );

  try {
    return getAddress(value);
  } catch {
    throw new Error(`Invalid contract address: ${value}`);
  }
}

export function resolvePrivateKey(options) {
  const privateKey = requireValue(
    options.privateKey || process.env.CHATTER_PRIVATE_KEY,
    "Missing wallet private key. Pass --private-key or set CHATTER_PRIVATE_KEY."
  );

  if (!/^0x[a-fA-F0-9]{64}$/u.test(privateKey)) {
    throw new Error("Wallet private key must be a 32-byte hex string starting with 0x.");
  }

  return privateKey;
}

export function resolveLimit(rawValue) {
  const limit = Number(rawValue ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }

  return limit;
}

export function resolveCursor(rawValue) {
  if (rawValue === undefined) {
    return 0n;
  }

  try {
    const cursor = BigInt(rawValue);
    if (cursor < 0n) {
      throw new Error("negative cursor");
    }

    return cursor;
  } catch {
    throw new Error("Cursor must be a non-negative integer.");
  }
}

export async function createConnections(options) {
  const rpcUrl = resolveRpcUrl(options);
  const contractAddress = resolveContractAddress(options);
  const privateKey = resolvePrivateKey(options);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl)
  });
  const chainId = await publicClient.getChainId();

  return {
    rpcUrl,
    contractAddress,
    privateKey,
    account,
    publicClient,
    walletClient,
    chainId
  };
}

export async function createPublicConnection(options) {
  const rpcUrl = resolveRpcUrl(options);
  const contractAddress = resolveContractAddress(options);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();

  return {
    rpcUrl,
    contractAddress,
    publicClient,
    chainId
  };
}

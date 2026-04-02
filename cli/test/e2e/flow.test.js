import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE_KEY = DEPLOYER_KEY;
const BOB_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ALICE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const E2E_TEST_OPTIONS = { timeout: 300_000, concurrency: false };

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function resolveFoundryBinary(name) {
  const envName = `${name.toUpperCase()}_BIN`;
  if (process.env[envName]) {
    return process.env[envName];
  }

  const preferred = commandName(name);

  const whichResult = spawnSync("bash", ["-lc", `command -v ${preferred}`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      FORCE_COLOR: "0"
    },
    encoding: "utf8"
  });
  if (whichResult.status === 0) {
    const resolved = String(whichResult.stdout || "").trim();
    if (resolved) {
      return resolved;
    }
  }

  const candidates = [];

  const forgeBin = process.env.FORGE_BIN;
  if (forgeBin) {
    candidates.push(path.join(path.dirname(forgeBin), preferred));
  }

  for (const segment of (process.env.PATH || "").split(path.delimiter)) {
    if (!segment) {
      continue;
    }

    const candidate = path.join(segment, preferred);
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return preferred;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Could not allocate a free TCP port."));
        });
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForRpc(url, { timeoutMs = 15_000 } = {}) {
  const startedAt = Date.now();

  for (;;) {
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        params: [],
        id: 1
      });

      const result = await new Promise((resolve, reject) => {
        const request = http.request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        }, (response) => {
          let contents = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            contents += chunk;
          });
          response.on("end", () => {
            resolve(contents);
          });
        });

        request.on("error", reject);
        request.write(body);
        request.end();
      });

      if (String(result).includes("\"result\":\"0x7a69\"")) {
        return;
      }
    } catch {
      // Retry until timeout below.
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for RPC at ${url}.`);
    }

    await delay(250);
  }
}

async function runCommand(command, args, {
  env = {},
  input = "",
  timeoutMs = 60_000
} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
        FORCE_COLOR: "0",
        ...env
      },
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      child.kill("SIGTERM");
      reject(new Error([
        `Command timed out: ${command} ${args.join(" ")}`,
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`
      ].filter(Boolean).join("\n\n")));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error([
          `Command failed: ${command} ${args.join(" ")}`,
          `exit=${code}`,
          stdout && `stdout:\n${stdout}`,
          stderr && `stderr:\n${stderr}`
        ].filter(Boolean).join("\n\n")));
        return;
      }

      resolve({ stdout, stderr });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function runCommandExpectFailure(command, args, options = {}) {
  try {
    await runCommand(command, args, options);
  } catch (error) {
    return String(error?.message || error);
  }

  throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`);
}

function createInteractiveSession(command, args, {
  env = {},
  timeoutMs = 120_000
} = {}) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      FORCE_COLOR: "0",
      ...env
    },
    stdio: "pipe"
  });

  let stdout = "";
  let stderr = "";
  let closed = false;
  const waiters = new Set();
  const timer = setTimeout(() => {
    if (!closed) {
      child.kill("SIGTERM");
    }
  }, timeoutMs);

  const closePromise = new Promise((resolve, reject) => {
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);

      for (const waiter of waiters) {
        waiter.reject(new Error(`Session closed before matcher was satisfied.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
      waiters.clear();

      if (code !== 0) {
        reject(new Error([
          `Command failed: ${command} ${args.join(" ")}`,
          `exit=${code}`,
          stdout && `stdout:\n${stdout}`,
          stderr && `stderr:\n${stderr}`
        ].filter(Boolean).join("\n\n")));
        return;
      }

      resolve({ stdout, stderr });
    });
  });

  function resolveWaiters() {
    for (const waiter of [...waiters]) {
      const slice = stdout.slice(waiter.fromIndex);
      const matched = typeof waiter.matcher === "string"
        ? slice.includes(waiter.matcher)
        : waiter.matcher.test(slice);

      if (!matched) {
        continue;
      }

      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(slice);
    }
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    resolveWaiters();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    send(chars) {
      child.stdin.write(chars);
    },
    waitFor(matcher, { fromIndex = stdout.length, timeoutMs: waitTimeoutMs = 30_000 } = {}) {
      const slice = stdout.slice(fromIndex);
      const matched = typeof matcher === "string"
        ? slice.includes(matcher)
        : matcher.test(slice);
      if (matched) {
        return Promise.resolve(slice);
      }

      return new Promise((resolve, reject) => {
        const timerId = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for matcher ${String(matcher)}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, waitTimeoutMs);

        const waiter = {
          matcher,
          fromIndex,
          timer: timerId,
          resolve,
          reject
        };
        waiters.add(waiter);
      });
    },
    async quit() {
      if (!closed) {
        child.stdin.write("q\n");
        child.stdin.end();
      }

      return closePromise;
    }
  };
}

function extractMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${label} in output:\n${source}`);
  }

  return match[1];
}

function extractLastShareCode(source) {
  const matches = [...source.matchAll(/shareCode:\n([A-Za-z0-9\-_]+)/g)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    throw new Error(`Could not find shareCode block in output:\n${source}`);
  }

  return lastMatch[1];
}

async function withLocalChain(callback) {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-e2e-"));
  const anvil = spawn(resolveFoundryBinary("anvil"), ["--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      FORCE_COLOR: "0"
    },
    stdio: "pipe"
  });

  let anvilStdout = "";
  let anvilStderr = "";
  anvil.stdout.on("data", (chunk) => {
    anvilStdout += chunk.toString();
  });
  anvil.stderr.on("data", (chunk) => {
    anvilStderr += chunk.toString();
  });

  try {
    await waitForRpc(rpcUrl);
    const deployed = await runCommand(commandName("forge"), [
      "script",
      "script/DeployChatterBlocks.s.sol:DeployChatterBlocksScript",
      "--rpc-url",
      rpcUrl,
      "--broadcast"
    ], {
      env: {
        CHATTER_PRIVATE_KEY: DEPLOYER_KEY
      },
      timeoutMs: 120_000
    });
    const contractAddress = extractMatch(
      deployed.stdout,
      /deployedAt: address (0x[a-fA-F0-9]{40})/,
      "contract address"
    );

    const aliceHome = path.join(tempRoot, "alice");
    const bobHome = path.join(tempRoot, "bob");

    await callback({
      rpcUrl,
      contractAddress,
      aliceEnv: {
        CHATTER_HOME: aliceHome,
        CHATTER_RPC_URL: rpcUrl,
        CHATTER_CONTRACT_ADDRESS: contractAddress,
        CHATTER_PRIVATE_KEY: ALICE_KEY
      },
      bobEnv: {
        CHATTER_HOME: bobHome,
        CHATTER_RPC_URL: rpcUrl,
        CHATTER_CONTRACT_ADDRESS: contractAddress,
        CHATTER_PRIVATE_KEY: BOB_KEY
      }
    });
  } finally {
    anvil.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }

  if (anvil.exitCode && anvil.exitCode !== 0) {
    throw new Error(`Anvil exited unexpectedly.\nstdout:\n${anvilStdout}\nstderr:\n${anvilStderr}`);
  }
}

test("CLI flow covers setup, rendezvous, accept, alias send, and decrypted inbox read", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv, bobEnv }) => {
    const aliceSetup = await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });
    const bobSetup = await runCommand(commandName("pnpm"), ["chat", "setup"], { env: bobEnv });
    assert.match(aliceSetup.stdout, /Registered chat key version 1/);
    assert.match(bobSetup.stdout, /Registered chat key version 1/);

    const post = await runCommand(commandName("pnpm"), [
      "chat", "hub", "post",
      "--phrase", "paper boat",
      "--expect", "silver tide"
    ], { env: aliceEnv });
    const inviteId = extractMatch(post.stdout, /inviteId=(\d+)/, "invite id");
    const shareCode = extractMatch(post.stdout, /shareCode=([A-Za-z0-9\-_]+)/, "share code");
    assert.equal(inviteId, "1");

    const list = await runCommand(commandName("pnpm"), ["chat", "hub", "list"], { env: bobEnv });
    assert.match(list.stdout, /#1 ACTIVE/);

    const respond = await runCommand(commandName("pnpm"), [
      "chat", "hub", "respond",
      "--bundle", shareCode
    ], { env: bobEnv });
    assert.match(respond.stdout, /Submitted response 1 for invite 1/);

    const responses = await runCommand(commandName("pnpm"), [
      "chat", "hub", "responses",
      "--invite-id", inviteId
    ], { env: aliceEnv });
    assert.match(responses.stdout, /#1 ACTIVE responder=0x7099\.\.\.79[cC]8 valid/);

    const accept = await runCommand(commandName("pnpm"), [
      "chat", "hub", "accept",
      "--invite-id", inviteId,
      "--response-id", "1"
    ], { env: aliceEnv });
    assert.match(accept.stdout, /Accepted response 1 for invite 1/);
    assert.match(accept.stdout, /Peer wallet: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8/);

    const matches = await runCommand(commandName("pnpm"), ["chat", "hub", "matches"], { env: bobEnv });
    assert.match(matches.stdout, /#1 responder peer=0xf39f\.\.\.2266/);

    const saveAlias = await runCommand(commandName("pnpm"), [
      "chat", "contacts", "save",
      "--address", ALICE_ADDRESS,
      "--alias", "alice"
    ], { env: bobEnv });
    assert.match(saveAlias.stdout, /Saved contact alice/);

    const send = await runCommand(commandName("pnpm"), [
      "chat", "send",
      "--to", "alice",
      "--message", "rendezvous worked"
    ], { env: bobEnv });
    assert.match(send.stdout, /Sent message 1 to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/);

    const inbox = await runCommand(commandName("pnpm"), [
      "chat", "inbox",
      "--with", BOB_ADDRESS
    ], { env: aliceEnv });
    assert.match(inbox.stdout, /Conversation with 0x7099\.\.\.79[cC]8/);
    assert.match(inbox.stdout, /rendezvous worked/);
  });
});

test("chat start drives the full Alice/Bob app flow with post, respond, accept, send, back, and quit", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv, bobEnv }) => {
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: bobEnv });

    const aliceApp = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: aliceEnv,
      timeoutMs: 120_000
    });
    const bobApp = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: bobEnv,
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      const aliceHomeSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceHomeSlice, /ChatterBlocks App/);
      assert.match(aliceHomeSlice, /Status: ready/);
      assert.match(aliceHomeSlice, /1\. Hub/);
      assert.match(aliceHomeSlice, /2\. Contacts/);
      assert.match(aliceHomeSlice, /3\. Settings/);
      assert.match(aliceHomeSlice, /4\. New conversation/);
      assert.match(aliceHomeSlice, /5\. Run setup/);
      assert.match(aliceHomeSlice, /6\. Refresh/);

      checkpoint = 0;
      const bobHomeSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobHomeSlice, /ChatterBlocks App/);
      assert.match(bobHomeSlice, /Status: ready/);
      assert.match(bobHomeSlice, /1\. Hub/);

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      const aliceHubSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceHubSlice, /Hub/);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      await aliceApp.waitFor("Phrase A:", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("paper boat\n");
      await aliceApp.waitFor("Phrase B:", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("silver tide\n");
      await aliceApp.waitFor("TTL hours [24]:", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("\n");
      const aliceInviteSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceInviteSlice, /Invite #1/);
      assert.match(aliceInviteSlice, /shareCode:/);

      const shareCode = extractLastShareCode(aliceApp.stdout);
      assert.ok(shareCode.length > 100);
      assert.doesNotMatch(shareCode, /\.\.\./);

      checkpoint = bobApp.stdout.length;
      bobApp.send("1\n");
      const bobHubSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobHubSlice, /Hub/);
      checkpoint = bobApp.stdout.length;
      bobApp.send("2\n");
      await bobApp.waitFor("Share code:", { fromIndex: checkpoint });
      checkpoint = bobApp.stdout.length;
      bobApp.send(`${shareCode}\n`);
      const bobResponseSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobResponseSlice, /Invite Response Submitted/);
      assert.match(bobResponseSlice, /Response ID: 1/);
      checkpoint = bobApp.stdout.length;
      bobApp.send("b\n");
      const bobHubReturnSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobHubReturnSlice, /Hub/);
      assert.match(bobHubReturnSlice, /Matches: 0/);

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("b\n");
      const aliceHubReturnSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceHubReturnSlice, /Hub/);
      assert.match(aliceHubReturnSlice, /Returned from share bundle\./);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("3\n");
      const aliceReviewChoiceSlice = await aliceApp.waitFor("Select invite:", { fromIndex: checkpoint });
      assert.match(aliceReviewChoiceSlice, /Review Invite Responses/);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      const aliceResponsesSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceResponsesSlice, /Responses for Invite #1/);
      assert.match(aliceResponsesSlice, /Accept response 1/);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      await aliceApp.waitFor("Accept anyway? [y/N]:", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("b\n");
      const aliceBackToResponses = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceBackToResponses, /Responses for Invite #1/);
      assert.match(aliceBackToResponses, /Acceptance cancelled\./);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      await aliceApp.waitFor("Accept anyway? [y/N]:", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("y\n");
      const aliceAcceptedSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceAcceptedSlice, /Match Accepted/);
      assert.match(aliceAcceptedSlice, /Fingerprint:/);
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("1\n");
      const aliceConversationSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(aliceConversationSlice, /Conversation/);
      assert.match(aliceConversationSlice, /No messages yet\./);

      checkpoint = bobApp.stdout.length;
      bobApp.send("4\n");
      const bobMatchesSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobMatchesSlice, /Matches/);
      assert.match(bobMatchesSlice, /Open 0xf39f...2266/);
      checkpoint = bobApp.stdout.length;
      bobApp.send("1\n");
      const bobConversationSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobConversationSlice, /Conversation/);
      assert.match(bobConversationSlice, /No messages yet\./);
      checkpoint = bobApp.stdout.length;
      bobApp.send("1\n");
      await bobApp.waitFor("Draft text:", { fromIndex: checkpoint });
      checkpoint = bobApp.stdout.length;
      bobApp.send("rendezvous worked\n");
      const bobDraftSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobDraftSlice, /Draft updated\./);
      checkpoint = bobApp.stdout.length;
      bobApp.send("2\n");
      const bobSentSlice = await bobApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(bobSentSlice, /Sent message 1\./);
      assert.match(bobSentSlice, /you: rendezvous worked/);

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("5\n");
      await aliceApp.waitFor("rendezvous worked", { fromIndex: checkpoint });
      checkpoint = aliceApp.stdout.length;
      aliceApp.send("b\n");
      const aliceHomeReturnSlice = await aliceApp.waitFor(/ChatterBlocks App[\s\S]*1\. Hub[\s\S]*q\. Quit/u, {
        fromIndex: checkpoint
      });
      assert.match(aliceHomeReturnSlice, /ChatterBlocks App/);
      assert.match(aliceHomeReturnSlice, /Matches: 1/);
      assert.match(aliceHomeReturnSlice, /Saved contacts: 1/);
      assert.match(aliceHomeReturnSlice, /1\. Hub/);
      assert.match(aliceHomeReturnSlice, /7\./);
      assert.doesNotMatch(aliceApp.stderr, /readline was closed/);
      assert.doesNotMatch(bobApp.stderr, /readline was closed/);
    } finally {
      await Promise.all([aliceApp.quit(), bobApp.quit()]);
    }
  });
});

test("conversation refresh pulls in new peer messages without breaking navigation", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv, bobEnv }) => {
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: bobEnv });

    const aliceApp = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: aliceEnv,
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("4\n");
      await aliceApp.waitFor("Address or alias:", { fromIndex: checkpoint });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send(`${BOB_ADDRESS}\n`);
      const conversationSlice = await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(conversationSlice, /Conversation/);
      assert.match(conversationSlice, /No messages yet\./);

      await runCommand(commandName("pnpm"), [
        "chat", "send",
        "--to", ALICE_ADDRESS,
        "--message", "incremental refresh works"
      ], { env: bobEnv });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("5\n");
      const refreshedSlice = await aliceApp.waitFor("incremental refresh works", { fromIndex: checkpoint });
      assert.match(refreshedSlice, /incremental refresh works/);

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("b\n");
      const homeSlice = await aliceApp.waitFor(/ChatterBlocks App[\s\S]*1\. Hub[\s\S]*q\. Quit/u, {
        fromIndex: checkpoint
      });
      assert.match(homeSlice, /ChatterBlocks App/);
      assert.doesNotMatch(aliceApp.stderr, /readline was closed/);
    } finally {
      await aliceApp.quit();
    }
  });
});

test("CHATTER_TIMING emits stable timing lines to stderr during home and conversation refresh", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv, bobEnv }) => {
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: bobEnv });

    const aliceApp = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: {
        ...aliceEnv,
        CHATTER_TIMING: "1"
      },
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("4\n");
      await aliceApp.waitFor("Address or alias:", { fromIndex: checkpoint });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send(`${BOB_ADDRESS}\n`);
      await aliceApp.waitFor("Select action:", { fromIndex: checkpoint });

      await runCommand(commandName("pnpm"), [
        "chat", "send",
        "--to", ALICE_ADDRESS,
        "--message", "timing refresh works"
      ], { env: bobEnv });

      checkpoint = aliceApp.stdout.length;
      aliceApp.send("5\n");
      await aliceApp.waitFor("timing refresh works", { fromIndex: checkpoint });
      await aliceApp.quit();

      assert.match(
        aliceApp.stderr,
        /^timing app\.renderHome total=\d+ms matches=\d+ms summaries=\d+ms activeInvites=\d+ms$/m
      );
      assert.match(
        aliceApp.stderr,
        /^timing app\.openConversation total=\d+ms thread=\d+ms contact=\d+ms(?: writeSeenState=\d+ms)?$/m
      );
      assert.match(
        aliceApp.stderr,
        /^timing wf\.readInbox total=\d+ms(?: conversationPage=\d+ms)? headersAndCiphertexts=\d+ms hydrate=\d+ms$/m
      );
      assert.doesNotMatch(aliceApp.stdout, /^timing /m);
      assert.doesNotMatch(aliceApp.stderr, /readline was closed/);
    } finally {
      try {
        await aliceApp.quit();
      } catch {
        // Session may already be closed.
      }
    }
  });
});

test("chat start prompts to unlock encrypted local state before health inspection", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv }) => {
    const encryptedEnv = {
      ...aliceEnv,
      CHATTER_PASSPHRASE: "correct horse battery staple"
    };

    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: encryptedEnv });
    await runCommand(commandName("pnpm"), [
      "chat", "hub", "post",
      "--phrase", "paper boat",
      "--expect", "silver tide"
    ], { env: encryptedEnv });

    const app = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: aliceEnv,
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      const unlockSlice = await app.waitFor("Passphrase:", { fromIndex: checkpoint });
      assert.match(unlockSlice, /Unlock Local State/);
      assert.match(unlockSlice, /Locked: chat keys, invite secrets/);

      checkpoint = app.stdout.length;
      app.send("wrong passphrase\n");
      const wrongPassSlice = await app.waitFor("Passphrase:", { fromIndex: checkpoint });
      assert.match(wrongPassSlice, /Invalid passphrase or corrupted encrypted local state\./);

      checkpoint = app.stdout.length;
      app.send("b\n");
      const blockedSlice = await app.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(blockedSlice, /Unlock Required/);
      assert.match(blockedSlice, /1\. Retry unlock/);
      assert.match(blockedSlice, /2\. Quit/);

      checkpoint = app.stdout.length;
      app.send("1\n");
      await app.waitFor("Passphrase:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("correct horse battery staple\n");
      const homeSlice = await app.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(homeSlice, /ChatterBlocks App/);
      assert.match(homeSlice, /Status: ready/);
      assert.match(homeSlice, /1\. Hub/);
      assert.match(homeSlice, /Last action: Unlocked chat keys and invite secrets\. Chat key ready/);
      assert.doesNotMatch(app.stderr, /readline was closed/);
    } finally {
      await app.quit();
    }
  });
});

test("contacts screen keeps fixed primary actions and validates add-contact in place", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv }) => {
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });

    const app = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: aliceEnv,
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      await app.waitFor("Select action:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("2\n");
      const contactsSlice = await app.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(contactsSlice, /Contacts/);
      assert.match(contactsSlice, /1\. Add contact/);
      assert.match(contactsSlice, /2\. Export contacts/);
      assert.match(contactsSlice, /3\. Import contacts/);
      assert.match(contactsSlice, /4\. Refresh/);

      checkpoint = app.stdout.length;
      app.send("1\n");
      await app.waitFor("Address:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("not-an-address\n");
      const invalidAddressSlice = await app.waitFor("Address:", { fromIndex: checkpoint });
      assert.match(invalidAddressSlice, /Add Contact/);
      assert.match(invalidAddressSlice, /Address must be a valid EVM address\./);

      checkpoint = app.stdout.length;
      app.send(`${BOB_ADDRESS}\n`);
      await app.waitFor("Alias:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("bob\n");
      await app.waitFor("Notes:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("\n");
      const savedContactsSlice = await app.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(savedContactsSlice, /Contact saved\./);
      assert.match(savedContactsSlice, /1\. Add contact/);
      assert.match(savedContactsSlice, /2\. Export contacts/);
      assert.match(savedContactsSlice, /3\. Import contacts/);
      assert.match(savedContactsSlice, /4\. Refresh/);
      assert.match(savedContactsSlice, /5\. Open bob/);
      assert.doesNotMatch(app.stderr, /readline was closed/);
    } finally {
      await app.quit();
    }
  });
});

test("secret backup export and import restore older message decryptability after historical key loss", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv, bobEnv }) => {
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: aliceEnv });
    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: bobEnv });

    await runCommand(commandName("pnpm"), [
      "chat", "send",
      "--to", ALICE_ADDRESS,
      "--message", "before rotate"
    ], { env: bobEnv, timeoutMs: 120_000 });

    await runCommand(commandName("pnpm"), ["chat", "setup", "--rotate"], { env: aliceEnv, timeoutMs: 120_000 });

    await runCommand(commandName("pnpm"), [
      "chat", "send",
      "--to", ALICE_ADDRESS,
      "--message", "after rotate"
    ], { env: bobEnv, timeoutMs: 120_000 });

    const backupPath = path.join(aliceEnv.CHATTER_HOME, "secret-backup.json");
    await runCommand(commandName("pnpm"), [
      "chat", "secrets", "export",
      "--file", backupPath
    ], { env: aliceEnv, timeoutMs: 120_000 });

    const keyringPath = path.join(
      aliceEnv.CHATTER_HOME,
      "31337",
      ALICE_ADDRESS.toLowerCase(),
      "keyring.json"
    );
    const tamperedKeyring = JSON.parse(await readFile(keyringPath, "utf8"));
    delete tamperedKeyring.keys["1"];
    tamperedKeyring.activeVersion = 2;
    await writeFile(keyringPath, `${JSON.stringify(tamperedKeyring, null, 2)}\n`);

    const degradedInbox = await runCommand(commandName("pnpm"), [
      "chat", "inbox",
      "--with", BOB_ADDRESS
    ], { env: aliceEnv });
    assert.match(degradedInbox.stdout, /missing local key version 1/);
    assert.match(degradedInbox.stdout, /after rotate/);

    await runCommand(commandName("pnpm"), [
      "chat", "secrets", "import",
      "--file", backupPath
    ], { env: aliceEnv, timeoutMs: 120_000 });

    const restoredInbox = await runCommand(commandName("pnpm"), [
      "chat", "inbox",
      "--with", BOB_ADDRESS
    ], { env: aliceEnv });
    assert.match(restoredInbox.stdout, /before rotate/);
    assert.match(restoredInbox.stdout, /after rotate/);
    assert.doesNotMatch(restoredInbox.stdout, /missing local key version/);
  });
});

test("encrypted secret backups import cleanly and settings show actual local secret state", E2E_TEST_OPTIONS, async () => {
  await withLocalChain(async ({ aliceEnv }) => {
    const passphrase = "correct horse battery staple";
    const encryptedEnv = {
      ...aliceEnv,
      CHATTER_PASSPHRASE: passphrase
    };
    const backupPath = path.join(aliceEnv.CHATTER_HOME, "encrypted-secret-backup.json");
    const walletStateDir = path.join(
      aliceEnv.CHATTER_HOME,
      "31337",
      ALICE_ADDRESS.toLowerCase()
    );

    await runCommand(commandName("pnpm"), ["chat", "setup"], { env: encryptedEnv });
    await runCommand(commandName("pnpm"), [
      "chat", "hub", "post",
      "--phrase", "paper boat",
      "--expect", "silver tide"
    ], { env: encryptedEnv, timeoutMs: 120_000 });
    await runCommand(commandName("pnpm"), [
      "chat", "secrets", "export",
      "--file", backupPath
    ], { env: encryptedEnv, timeoutMs: 120_000 });

    await rm(path.join(walletStateDir, "keyring.json"), { force: true });
    await rm(path.join(walletStateDir, "hub.json"), { force: true });

    await runCommand(commandName("pnpm"), [
      "chat", "secrets", "import",
      "--file", backupPath
    ], { env: aliceEnv, timeoutMs: 120_000 });

    const showOutput = await runCommand(commandName("pnpm"), ["chat", "secrets", "show"], {
      env: aliceEnv
    });
    assert.match(showOutput.stdout, /keyring\.json: encrypted/);
    assert.match(showOutput.stdout, /keyring readable: no/);
    assert.match(showOutput.stdout, /hub\.json: encrypted/);
    assert.match(showOutput.stdout, /hub readable: no/);

    const app = createInteractiveSession(commandName("pnpm"), ["chat", "start"], {
      env: aliceEnv,
      timeoutMs: 120_000
    });

    try {
      let checkpoint = 0;
      await app.waitFor("Passphrase:", { fromIndex: checkpoint });
      checkpoint = app.stdout.length;
      app.send(`${passphrase}\n`);
      await app.waitFor("Select action:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("3\n");
      await app.waitFor("Select action:", { fromIndex: checkpoint });

      checkpoint = app.stdout.length;
      app.send("2\n");
      const localSecretStateSlice = await app.waitFor("Select action:", { fromIndex: checkpoint });
      assert.match(localSecretStateSlice, /Local Secret State/);
      assert.match(localSecretStateSlice, /Passphrase active: yes/);
      assert.match(localSecretStateSlice, /keyring\.json: encrypted/);
      assert.match(localSecretStateSlice, /readable now: yes/);
      assert.match(localSecretStateSlice, /hub\.json: encrypted/);
      assert.match(localSecretStateSlice, /stored invites: 1/);
      assert.doesNotMatch(app.stderr, /readline was closed/);
    } finally {
      await app.quit();
    }
  });
});

test("demo-local helper enforces sessions and prints isolated env blocks", E2E_TEST_OPTIONS, async () => {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const demoRoot = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-demo-"));
  const anvil = spawn(resolveFoundryBinary("anvil"), ["--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_PROXY: "127.0.0.1,localhost",
      FORCE_COLOR: "0"
    },
    stdio: "pipe"
  });

  try {
    await waitForRpc(rpcUrl);

    const missingSession = await runCommandExpectFailure(commandName("bash"), ["scripts/demo-local.sh", "env"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl
      }
    });
    assert.match(missingSession, /Missing demo session/);

    const firstDeploy = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "deploy"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl,
        CHATTER_PRIVATE_KEY: DEPLOYER_KEY
      },
      timeoutMs: 120_000
    });
    assert.match(firstDeploy.stdout, /Demo session:/);
    assert.match(firstDeploy.stdout, /export CHATTER_HOME=/);
    const firstSessionId = extractMatch(firstDeploy.stdout, /Demo session: ([^\n]+)/, "first demo session id");

    const firstEnv = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "env"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl
      }
    });
    assert.match(firstEnv.stdout, new RegExp(`export DEMO_SESSION_ID=${firstSessionId}`));

    const secondDeploy = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "deploy"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl,
        CHATTER_PRIVATE_KEY: DEPLOYER_KEY,
        CHATTER_DEMO_SESSION_ID: "second-session"
      },
      timeoutMs: 120_000
    });
    assert.match(secondDeploy.stdout, /Demo session: second-session/);
    assert.doesNotMatch(secondDeploy.stdout, new RegExp(`Demo session: ${firstSessionId}`));

    const secondEnv = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "env"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl
      }
    });
    assert.match(secondEnv.stdout, /export DEMO_SESSION_ID=second-session/);
    assert.match(secondEnv.stdout, /export CHATTER_CONTRACT_ADDRESS=0x[a-fA-F0-9]{40}/);

    const cleaned = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "clean"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot
      }
    });
    assert.match(cleaned.stdout, /Cleared demo session state\./);

    const missingAfterClean = await runCommandExpectFailure(commandName("bash"), ["scripts/demo-local.sh", "env"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        RPC_URL: rpcUrl
      }
    });
    assert.match(missingAfterClean, /Missing demo session/);
  } finally {
    anvil.kill("SIGTERM");
    await rm(demoRoot, { recursive: true, force: true });
  }
});

test("demo:fresh starts a managed chain and demo:status reports managed session state", E2E_TEST_OPTIONS, async () => {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const demoRoot = await mkdtemp(path.join(os.tmpdir(), "chatter-blocks-demo-fresh-"));

  try {
    const fresh = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "fresh"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot,
        CHATTER_RPC_URL: rpcUrl,
        CHATTER_PRIVATE_KEY: DEPLOYER_KEY
      },
      timeoutMs: 180_000
    });
    assert.match(fresh.stdout, /Demo session:/);
    assert.match(fresh.stdout, /Managed Anvil PID:/);
    assert.match(fresh.stdout, new RegExp(`export CHATTER_RPC_URL=${rpcUrl}`));

    const status = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "status"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot
      }
    });
    assert.match(status.stdout, /## Demo status/);
    assert.match(status.stdout, /Managed chain: running/);
    assert.match(status.stdout, new RegExp(`Managed chain RPC: ${rpcUrl}`));
    assert.match(status.stdout, /Session: /);

    const cleaned = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "clean"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot
      }
    });
    assert.match(cleaned.stdout, /Cleared demo session state\./);

    const statusAfterClean = await runCommand(commandName("bash"), ["scripts/demo-local.sh", "status"], {
      env: {
        CHATTER_DEMO_ROOT: demoRoot
      }
    });
    assert.match(statusAfterClean.stdout, /Session: none/);
    assert.match(statusAfterClean.stdout, /Managed chain: none/);
  } finally {
    await rm(demoRoot, { recursive: true, force: true });
  }
});

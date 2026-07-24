import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "codex-collab-flow-"));
const port = 43_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const relayEntry = resolve("apps/relay/dist/server.js");
const relay = spawn(process.execPath, [relayEntry], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_COLLAB_DATA_DIR: dataDir,
    CODEX_COLLAB_DATABASE: join(dataDir, "relay.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let relayOutput = "";
relay.stdout.on("data", (chunk) => {
  relayOutput += chunk.toString("utf8");
});
relay.stderr.on("data", (chunk) => {
  relayOutput += chunk.toString("utf8");
});

async function request(path, init = {}, expectedStatus) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  if (expectedStatus !== undefined) {
    if (response.status !== expectedStatus) {
      throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}`);
    }
    return body;
  }
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${body.error?.message ?? "unknown"}`);
  }
  return body;
}

async function waitForRelay() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request("/health");
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Relay did not start. Output: ${relayOutput.slice(-1_000)}`);
}

try {
  await waitForRelay();
  const created = await request("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ name: "Code flow", ownerDisplayName: "Owner" }),
  });
  const ownerHeaders = { authorization: `Bearer ${created.memberToken}` };
  const pairing = await request(`/v1/sessions/${created.session.id}/host-pairings`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ expiresInMinutes: 10 }),
  });
  const claimed = await request("/v1/host-pairings/claim", {
    method: "POST",
    body: JSON.stringify({
      pairingToken: pairing.pairingToken,
      deviceLabel: "Code test host",
      rootLabel: "Codex-Collab",
    }),
  });
  const hostHeaders = { authorization: `Bearer ${claimed.memberToken}` };
  await request(`/v1/sessions/${created.session.id}/workspace/catalog`, {
    method: "PUT",
    headers: hostHeaders,
    body: JSON.stringify({
      deviceLabel: "Code test host",
      rootLabel: "Codex-Collab",
      threads: [
        {
          id: "thread-code-flow",
          name: "Code-only closed loop",
          preview: "Verify task and file import",
          updatedAt: 1_753_401_600,
        },
      ],
    }),
  });

  const invite = await request(`/v1/sessions/${created.session.id}/invites`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 }),
  });
  const guest = await request("/v1/invites/join", {
    method: "POST",
    body: JSON.stringify({ inviteToken: invite.inviteToken, displayName: "Reviewer" }),
  });
  await request(
    `/v1/sessions/${created.session.id}/workspace`,
    { headers: { authorization: `Bearer ${guest.memberToken}` } },
    403,
  );
  await request(
    `/v1/sessions/${created.session.id}/members/${guest.member.id}/approve`,
    { method: "POST", headers: ownerHeaders, body: "{}" },
  );
  await request(`/v1/sessions/${created.session.id}/workspace/selection`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ threadId: "thread-code-flow" }),
  });
  await request(`/v1/sessions/${created.session.id}/workspace/snapshot`, {
    method: "PUT",
    headers: hostHeaders,
    body: JSON.stringify({
      threadId: "thread-code-flow",
      history: [
        {
          id: "visible-user-message",
          role: "user",
          text: "Run the code-only loop",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "visible-assistant-message",
          role: "assistant",
          text: "The loop passed.",
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      ],
      files: [
        {
          path: "README.md",
          content: "# Code-only loop\n",
          size: 17,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: "b".repeat(64),
        },
      ],
    }),
  });

  const guestHeaders = { authorization: `Bearer ${guest.memberToken}` };
  const workspace = await request(`/v1/sessions/${created.session.id}/workspace`, {
    headers: guestHeaders,
  });
  const file = await request(
    `/v1/sessions/${created.session.id}/workspace/file?path=${encodeURIComponent("README.md")}`,
    { headers: guestHeaders },
  );
  if (
    workspace.workspace.selectedThreadId !== "thread-code-flow" ||
    workspace.workspace.history.length !== 2 ||
    workspace.workspace.files.length !== 1 ||
    workspace.workspace.threads.length !== 0 ||
    file.file.content !== "# Code-only loop\n"
  ) {
    throw new Error("Workspace flow returned an unexpected final state");
  }

  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "owner session",
        "one-time host pairing",
        "task catalog",
        "pending-member denial",
        "owner approval",
        "task selection",
        "history import",
        "approved-member file read",
      ],
    }),
  );
} finally {
  relay.kill("SIGTERM");
  await new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, 2_000);
    relay.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
  await rm(dataDir, { recursive: true, force: true });
}

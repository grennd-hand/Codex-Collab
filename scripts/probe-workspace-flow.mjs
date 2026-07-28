import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { FileSandbox } from "../plugins/codex-collab/dist/file-sandbox.js";
import { RelayClient } from "../plugins/codex-collab/dist/relay-client.js";
import { processNextWorkspaceFileOperation } from "../plugins/codex-collab/dist/workspace-file-operations.js";

const dataDir = await mkdtemp(join(tmpdir(), "codex-collab-flow-"));
const projectRoot = join(dataDir, "project");
await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, "README.md"), "# initial\n", "utf8");
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

async function connectRealtime(ticket) {
  return new Promise((resolveConnection, rejectConnection) => {
    const url = new URL("/v1/realtime", origin);
    url.protocol = "ws:";
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      rejectConnection(new Error("Realtime connection timed out"));
    }, 5_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolveConnection({ socket, envelope: JSON.parse(String(data)) });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectConnection(error);
    });
  });
}

async function expectRealtimeTicketRejected(ticket) {
  return new Promise((resolveRejection, rejectRejection) => {
    const url = new URL("/v1/realtime", origin);
    url.protocol = "ws:";
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      rejectRejection(new Error("Reused realtime ticket was not rejected"));
    }, 5_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      if (response.statusCode === 401) {
        resolveRejection();
      } else {
        rejectRejection(
          new Error(`Reused realtime ticket returned ${response.statusCode}`),
        );
      }
    });
    socket.once("error", () => {
      // ws also emits an error after a rejected HTTP upgrade; unexpected-response owns the result.
    });
  });
}

async function waitForRealtime(socket, predicate) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      rejectEvent(new Error("Expected realtime event was not received"));
    }, 5_000);
    const onMessage = (data) => {
      const envelope = JSON.parse(String(data));
      if (!predicate(envelope)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolveEvent(envelope);
    };
    socket.on("message", onMessage);
  });
}

try {
  await waitForRelay();
  const created = await request("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ name: "Code flow", ownerDisplayName: "Owner" }),
  });
  const ownerHeaders = { authorization: `Bearer ${created.memberToken}` };
  const realtimeTicket = await request(
    `/v1/sessions/${created.session.id}/realtime-tickets`,
    { method: "POST", headers: ownerHeaders, body: "{}" },
  );
  const realtime = await connectRealtime(realtimeTicket.ticket);
  if (
    realtime.envelope.type !== "ready" ||
    realtime.envelope.sessionId !== created.session.id
  ) {
    throw new Error("Realtime ticket returned an unexpected ready envelope");
  }
  realtime.socket.close();
  await expectRealtimeTicketRejected(realtimeTicket.ticket);
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
  const approval = await request(
    `/v1/sessions/${created.session.id}/members/${guest.member.id}/approve`,
    { method: "POST", headers: ownerHeaders, body: "{}" },
  );
  if (approval.member.workspaceFileAccess !== "workspace-write") {
    throw new Error("Owner approval must grant the member workspace write access");
  }
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
        {
          id: "visible-reasoning-summary",
          role: "reasoning",
          text: "Checked the workspace contract.",
          createdAt: "2026-07-25T00:00:01.500Z",
        },
        {
          id: "visible-command-output",
          role: "command",
          text: "$ npm test\n21 tests passed\nexit code: 0",
          createdAt: "2026-07-25T00:00:02.000Z",
        },
      ],
      files: [
        {
          path: "README.md",
          content: "# Code-only loop\n",
          size: 17,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("# Code-only loop\n").digest("hex"),
        },
        {
          path: ".codex/config.toml",
          content: "model = \"gpt-5\"\n",
          size: 16,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update('model = "gpt-5"\n').digest("hex"),
        },
      ],
    }),
  });
  await request(`/v1/sessions/${created.session.id}/workspace/history`, {
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
        {
          id: "visible-reasoning-summary",
          role: "reasoning",
          text: "Checked the workspace contract.",
          createdAt: "2026-07-25T00:00:01.500Z",
        },
        {
          id: "visible-command-output",
          role: "command",
          text: "$ npm test\n21 tests passed\nexit code: 0",
          createdAt: "2026-07-25T00:00:02.000Z",
        },
        {
          id: "visible-running-command",
          role: "command",
          text: "tool: exec_command\nstatus: running\ninput:\nnpm run build",
          createdAt: "2026-07-25T00:00:03.000Z",
        },
      ],
    }),
  });

  const guestHeaders = { authorization: `Bearer ${guest.memberToken}` };
  const guestRealtimeTicket = await request(
    `/v1/sessions/${created.session.id}/realtime-tickets`,
    { method: "POST", headers: guestHeaders, body: "{}" },
  );
  const guestRealtime = await connectRealtime(guestRealtimeTicket.ticket);
  const originalHash = createHash("sha256").update("# initial\n").digest("hex");
  const queuedEventPromise = waitForRealtime(
    guestRealtime.socket,
    (envelope) =>
      envelope.type === "file.operation.updated" &&
      envelope.payload?.status === "queued",
  );
  const queuedWrite = await request(
    `/v1/sessions/${created.session.id}/workspace/file-operations`,
    {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({
        kind: "write",
        path: "README.md",
        content: "# saved by IDE\n",
        expectedSha256: originalHash,
      }),
    },
    202,
  );
  if (queuedWrite.operation.status !== "queued" || queuedWrite.operation.completedAt !== null) {
    throw new Error("A browser save must remain queued until the host writes it");
  }
  const queuedEvent = await queuedEventPromise;
  const eventKeys = Object.keys(queuedEvent.payload ?? {}).sort();
  if (
    JSON.stringify(eventKeys) !==
    JSON.stringify(["operationId", "requestedByMemberId", "status"])
  ) {
    throw new Error("Realtime file operation events must contain identifiers and status only");
  }
  const relayClient = new RelayClient(origin);
  const sandbox = await FileSandbox.create(projectRoot);
  const completedEventPromise = waitForRealtime(
    guestRealtime.socket,
    (envelope) =>
      envelope.type === "file.operation.updated" &&
      envelope.payload?.operationId === queuedWrite.operation.id &&
      envelope.payload?.status === "completed",
  );
  const completedWrite = await processNextWorkspaceFileOperation(
    created.session.id,
    claimed.memberToken,
    relayClient,
    sandbox,
  );
  if (
    completedWrite?.id !== queuedWrite.operation.id ||
    completedWrite.status !== "completed" ||
    (await readFile(join(projectRoot, "README.md"), "utf8")) !== "# saved by IDE\n"
  ) {
    throw new Error("Host sandbox did not complete the queued IDE save");
  }
  const completedEvent = await completedEventPromise;
  if (
    JSON.stringify(Object.keys(completedEvent.payload ?? {}).sort()) !==
    JSON.stringify(["operationId", "requestedByMemberId", "status"])
  ) {
    throw new Error("Completed file events must not broadcast exact workspace paths");
  }

  const savedHash = completedWrite.resultFile.sha256;
  await writeFile(join(projectRoot, "README.md"), "# host changed\n", "utf8");
  const staleWrite = await request(
    `/v1/sessions/${created.session.id}/workspace/file-operations`,
    {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({
        kind: "write",
        path: "README.md",
        content: "# stale browser edit\n",
        expectedSha256: savedHash,
      }),
    },
    202,
  );
  const conflictEventPromise = waitForRealtime(
    guestRealtime.socket,
    (envelope) =>
      envelope.type === "file.operation.updated" &&
      envelope.payload?.operationId === staleWrite.operation.id &&
      envelope.payload?.status === "failed",
  );
  const conflict = await processNextWorkspaceFileOperation(
    created.session.id,
    claimed.memberToken,
    relayClient,
    sandbox,
  );
  if (
    conflict?.id !== staleWrite.operation.id ||
    conflict.status !== "failed" ||
    conflict.errorCode !== "file_conflict" ||
    conflict.resultFile?.content !== "# host changed\n" ||
    (await readFile(join(projectRoot, "README.md"), "utf8")) !== "# host changed\n"
  ) {
    throw new Error("Stale IDE save did not return the authoritative conflict safely");
  }
  const conflictEvent = await conflictEventPromise;
  if (
    JSON.stringify(Object.keys(conflictEvent.payload ?? {}).sort()) !==
    JSON.stringify(["operationId", "requestedByMemberId", "status"])
  ) {
    throw new Error("Conflict events must not broadcast paths, errors, or file content");
  }

  const attributedPrompt = await request(
    `/v1/sessions/${created.session.id}/messages`,
    {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({ kind: "codex_prompt", body: "Run focused tests" }),
    },
    201,
  );
  if (attributedPrompt.message.workspaceThreadId !== "thread-code-flow") {
    throw new Error("Codex prompt was not attributed to the selected task");
  }
  guestRealtime.socket.close();

  const workspace = await request(`/v1/sessions/${created.session.id}/workspace`, {
    headers: guestHeaders,
  });
  const file = await request(
    `/v1/sessions/${created.session.id}/workspace/file?path=${encodeURIComponent("README.md")}`,
    { headers: guestHeaders },
  );
  if (
    workspace.workspace.selectedThreadId !== "thread-code-flow" ||
    workspace.workspace.history.length !== 5 ||
    workspace.workspace.files.length !== 2 ||
    workspace.workspace.threads.length !== 0 ||
    file.file.content !== "# host changed\n"
  ) {
    throw new Error("Workspace flow returned an unexpected final state");
  }

  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "owner session",
        "one-time realtime ticket",
        "one-time host pairing",
        "task catalog",
        "pending-member denial",
        "owner approval",
        "task selection",
        "history import",
        "live history update without file replacement",
        "approved-member file read",
        "approval grants workspace write",
        "durable queued operation",
        "content-free realtime file event",
        "host FileSandbox write completion",
        "stale-hash conflict without overwrite",
        "selected-task Codex prompt attribution",
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

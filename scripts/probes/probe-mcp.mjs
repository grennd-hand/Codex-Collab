import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverPath = join(projectRoot, "plugins", "codex-collab", "dist", "mcp-server.js");
const brokerPath = join(
  projectRoot,
  "native",
  "host-ipc",
  "target",
  "release",
  "codex-collab-host-ipc.exe",
);
const stateDirectory = await mkdtemp(join(tmpdir(), "codex-collab-mcp-probe-"));
const child = spawn(process.execPath, [serverPath], {
  cwd: join(projectRoot, "plugins", "codex-collab"),
  env: {
    ...process.env,
    CODEX_COLLAB_HOST_STATE_DIR: stateDirectory,
    CODEX_COLLAB_HOST_IPC_BROKER: brokerPath,
    CODEX_COLLAB_STATE_FILE: join(stateDirectory, "profile.json"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function request(id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) {
        reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }
    });
  });
}

let hostStopped = false;

try {
  const initialize = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-collab-probe", version: "0.1.0" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  const listed = await request(2, "tools/list");
  const names = listed.tools.map((tool) => tool.name);
  if (!names.includes("collab_create_session") || !names.includes("collab_forward_prompt")) {
    throw new Error(`Expected tools are missing: ${names.join(", ")}`);
  }
  const statusCall = await request(3, "tools/call", {
    name: "collab_status",
    arguments: {},
  });
  if (!Array.isArray(statusCall?.content) || statusCall.content.length === 0) {
    throw new Error("collab_status did not return an MCP tool response through the Host");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        serverInfo: initialize.serverInfo,
        protocolVersion: initialize.protocolVersion,
        toolCount: names.length,
        tools: names,
        hostToolRoute: {
          tool: "collab_status",
          responded: true,
          isError: statusCall.isError === true,
        },
      },
      null,
      2,
    )}\n`,
  );
  await stopTemporaryHost();
} finally {
  child.kill();
  await stopTemporaryHost().catch(() => undefined);
  await rm(stateDirectory, { recursive: true, force: true });
}

async function stopTemporaryHost() {
  if (hostStopped) return;
  const { readHostIpcEndpoint } = await import(
    "../../plugins/codex-collab/dist/host/ipc/endpoint.js"
  );
  if (!(await readHostIpcEndpoint("desktop", stateDirectory))) return;

  const { connectOrStartHostIpc } = await import(
    "../../plugins/codex-collab/dist/host/workspace-sync-worker-control.js"
  );
  const desktopClient = await connectOrStartHostIpc({
    clientKind: "desktop",
    stateDirectory,
    brokerPath,
  });
  try {
    await desktopClient.gracefulStop();
  } finally {
    desktopClient.close();
  }

  const deadline = Date.now() + 15_000;
  while (await readHostIpcEndpoint("desktop", stateDirectory)) {
    if (Date.now() >= deadline) throw new Error("Temporary Host did not stop cleanly");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  hostStopped = true;
}

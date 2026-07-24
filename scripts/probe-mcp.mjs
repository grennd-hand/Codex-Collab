import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectRoot, "plugins", "codex-collab", "dist", "mcp-server.js");
const child = spawn(process.execPath, [serverPath], {
  cwd: join(projectRoot, "plugins", "codex-collab"),
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
    }, 10_000);
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
  process.stdout.write(
    `${JSON.stringify(
      {
        serverInfo: initialize.serverInfo,
        protocolVersion: initialize.protocolVersion,
        toolCount: names.length,
        tools: names,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  child.kill();
}

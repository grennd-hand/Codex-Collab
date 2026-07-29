import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpHostIpcClientManager } from "./host/ipc/mcp-client-manager.js";
import { isHostToolMethod } from "./host/ipc/protocol.js";
import { collabTools } from "./mcp/mcp-tool-catalog.js";
import { ensureWorkspaceSyncWorker } from "./host/workspace-sync-worker-control.js";

const server = new Server(
  { name: "codex-collab", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
const hostClients = new McpHostIpcClientManager(() => ensureWorkspaceSyncWorker());

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...collabTools] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!isHostToolMethod(request.params.name)) {
      throw new Error(`Unknown Codex Collab tool: ${request.params.name}`);
    }
    return text(
      await hostClients.callTool(
        request.params.name,
        request.params.arguments ?? {},
      ),
    );
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

server.onerror = (error) => {
  console.error("[codex-collab MCP]", error);
};

let closing = false;
async function closeMcp(): Promise<void> {
  if (closing) return;
  closing = true;
  hostClients.close();
  await server.close();
}

process.once("SIGINT", () => void closeMcp().finally(() => process.exit(0)));
process.once("SIGTERM", () => void closeMcp().finally(() => process.exit(0)));
process.stdin.once("end", () => void closeMcp());

await server.connect(new StdioServerTransport());

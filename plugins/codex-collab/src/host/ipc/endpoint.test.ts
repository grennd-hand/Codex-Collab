import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostIpcCapability } from "./authentication.js";
import {
  hostIpcEndpointPath,
  publishHostIpcEndpoint,
  readHostIpcEndpoint,
  removeHostIpcEndpoint,
} from "./endpoint.js";

const directories: string[] = [];
const instanceId = "0123456789abcdef0123456789abcdef";

function capabilities(): readonly HostIpcCapability[] {
  return [
    { clientKind: "mcp", keyId: "mcp-key", secret: Buffer.alloc(32, 1) },
    { clientKind: "desktop", keyId: "desktop-key", secret: Buffer.alloc(32, 2) },
  ];
}

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-collab-endpoint-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Host IPC endpoint", () => {
  it("atomically publishes one strict client capability at a time", async () => {
    const directory = await stateDirectory();
    await publishHostIpcEndpoint(
      {
        v: 1,
        instanceId,
        pipePath: `\\\\.\\pipe\\codex-collab-host-${instanceId}`,
        hostPid: 101,
        brokerPid: 102,
        createdAt: "2026-07-28T00:00:00.000Z",
        capabilities: capabilities(),
      },
      directory,
    );

    const endpoint = await readHostIpcEndpoint("desktop", directory);
    expect(endpoint).toMatchObject({ instanceId, hostPid: 101, brokerPid: 102 });
    expect(endpoint?.capability).toMatchObject({ clientKind: "desktop", keyId: "desktop-key" });
    expect(endpoint?.capability.secret).toEqual(Buffer.alloc(32, 2));
    const serialized = JSON.parse(await readFile(hostIpcEndpointPath(directory), "utf8"));
    expect(serialized.capabilities).toHaveLength(2);
  });

  it("rejects malformed or non-canonical pipe endpoints", async () => {
    const directory = await stateDirectory();
    await writeFile(
      hostIpcEndpointPath(directory),
      JSON.stringify({
        v: 1,
        instanceId,
        pipePath: "\\\\.\\pipe\\arbitrary",
        hostPid: 1,
        brokerPid: 2,
        createdAt: "2026-07-28T00:00:00.000Z",
        capabilities: capabilities().map((capability) => ({
          ...capability,
          secret: Buffer.from(capability.secret).toString("base64url"),
        })),
      }),
    );
    await expect(readHostIpcEndpoint("mcp", directory)).rejects.toThrow("pipe path is invalid");
  });

  it("only removes an endpoint owned by the stopping generation", async () => {
    const directory = await stateDirectory();
    await publishHostIpcEndpoint(
      {
        v: 1,
        instanceId,
        pipePath: `\\\\.\\pipe\\codex-collab-host-${instanceId}`,
        hostPid: 101,
        brokerPid: 102,
        createdAt: "2026-07-28T00:00:00.000Z",
        capabilities: capabilities(),
      },
      directory,
    );
    await removeHostIpcEndpoint("fedcba9876543210fedcba9876543210", directory);
    await expect(readHostIpcEndpoint("mcp", directory)).resolves.not.toBeNull();
    await removeHostIpcEndpoint(instanceId, directory);
    await expect(readHostIpcEndpoint("mcp", directory)).resolves.toBeNull();
  });
});

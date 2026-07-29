import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRuntimeLockPath } from "./host-runtime-lock.js";
import type { HostIpcCapability } from "./ipc/authentication.js";
import { publishHostIpcEndpoint } from "./ipc/endpoint.js";
import type { McpHostIpcClient } from "./ipc/transport.js";
import {
  connectOrStartHostIpc,
  type HostWorkerLaunchSpec,
} from "./workspace-sync-worker-control.js";

const directories: string[] = [];
const instanceId = "0123456789abcdef0123456789abcdef";

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-collab-control-"));
  directories.push(directory);
  return directory;
}

function capabilities(): readonly HostIpcCapability[] {
  return [
    { clientKind: "mcp", keyId: "mcp-key", secret: Buffer.alloc(32, 1) },
    { clientKind: "desktop", keyId: "desktop-key", secret: Buffer.alloc(32, 2) },
  ];
}

async function publish(directory: string, hostPid: number): Promise<void> {
  await publishHostIpcEndpoint(
    {
      v: 1,
      instanceId,
      pipePath: `\\\\.\\pipe\\codex-collab-host-${instanceId}`,
      hostPid,
      brokerPid: hostPid + 1,
      createdAt: "2026-07-28T00:00:00.000Z",
      capabilities: capabilities(),
    },
    directory,
  );
}

function client() {
  return {
    callTool: vi.fn(),
    status: vi.fn().mockResolvedValue({
      phase: "active",
      paired: true,
      acceptingWork: true,
      since: "2026-07-28T00:00:00.000Z",
    }),
    close: vi.fn(),
  } satisfies McpHostIpcClient;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace sync worker control", () => {
  it("connects first and never spawns when a ready Host exists", async () => {
    const directory = await stateDirectory();
    await publish(directory, 101);
    const existing = client();
    const spawnWorker = vi.fn();

    await expect(
      connectOrStartHostIpc({
        clientKind: "mcp",
        stateDirectory: directory,
        isProcessRunning: (pid) => pid === 101,
        connectClient: vi.fn().mockResolvedValue(existing),
        spawnWorker,
      }),
    ).resolves.toBe(existing);
    expect(existing.status).toHaveBeenCalledTimes(1);
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("returns host_restart_required for a live legacy lock without an endpoint", async () => {
    const directory = await stateDirectory();
    await writeFile(hostRuntimeLockPath(directory), JSON.stringify({ pid: 202 }), "utf8");
    const spawnWorker = vi.fn();

    await expect(
      connectOrStartHostIpc({
        clientKind: "mcp",
        stateDirectory: directory,
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
        isProcessRunning: (pid) => pid === 202,
        connectClient: vi.fn(),
        spawnWorker,
      }),
    ).rejects.toMatchObject({ code: "host_restart_required" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("spawns once only when no live lock or endpoint exists, then verifies readiness", async () => {
    const directory = await stateDirectory();
    const readyClient = client();
    const launches: HostWorkerLaunchSpec[] = [];

    const connected = await connectOrStartHostIpc({
      clientKind: "mcp",
      stateDirectory: directory,
      workerPath: "C:\\app\\workspace-sync-worker.js",
      brokerPath: "C:\\app\\codex-collab-host-ipc.exe",
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
      isProcessRunning: (pid) => pid === 303,
      spawnWorker: async (spec) => {
        launches.push(spec);
        await publish(directory, 303);
      },
      connectClient: vi.fn().mockResolvedValue(readyClient),
    });

    expect(connected).toBe(readyClient);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      workerPath: "C:\\app\\workspace-sync-worker.js",
      brokerPath: "C:\\app\\codex-collab-host-ipc.exe",
      stateDirectory: directory,
    });
    expect(launches[0]?.env.CODEX_COLLAB_HOST_STATE_DIR).toBe(directory);
    expect(launches[0]?.env.CODEX_COLLAB_HOST_IPC_BROKER).toBe(
      "C:\\app\\codex-collab-host-ipc.exe",
    );
  });

  it("does not delete or replace an endpoint while its Host process is live", async () => {
    const directory = await stateDirectory();
    await publish(directory, 404);
    const spawnWorker = vi.fn();
    const connectClient = vi.fn().mockRejectedValue(new Error("pipe unavailable"));

    await expect(
      connectOrStartHostIpc({
        clientKind: "mcp",
        stateDirectory: directory,
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
        isProcessRunning: (pid) => pid === 404,
        connectClient,
        spawnWorker,
      }),
    ).rejects.toMatchObject({ code: "host_restart_required" });
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(connectClient).toHaveBeenCalled();
  });
});

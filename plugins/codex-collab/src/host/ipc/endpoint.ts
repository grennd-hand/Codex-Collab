import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { localProfilePath } from "../../local-profile.js";
import type { HostIpcCapability } from "./authentication.js";
import { HOST_IPC_PROTOCOL_VERSION, type HostIpcClientKind, HostIpcProtocolError } from "./protocol.js";

export interface PublishedHostIpcEndpointV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  instanceId: string;
  pipePath: string;
  hostPid: number;
  brokerPid: number;
  createdAt: string;
  capabilities: readonly HostIpcCapability[];
}

export interface HostIpcClientEndpointV1 {
  v: typeof HOST_IPC_PROTOCOL_VERSION;
  instanceId: string;
  pipePath: string;
  hostPid: number;
  brokerPid: number;
  capability: HostIpcCapability;
}

interface SerializedEndpointV1 {
  v: 1;
  instanceId: string;
  pipePath: string;
  hostPid: number;
  brokerPid: number;
  createdAt: string;
  capabilities: Array<{
    clientKind: HostIpcClientKind;
    keyId: string;
    secret: string;
  }>;
}

const instancePattern = /^[a-f0-9]{32}$/;
const pipePrefix = "\\\\.\\pipe\\codex-collab-host-";

export function hostIpcStateDirectory(): string {
  return process.env.CODEX_COLLAB_HOST_STATE_DIR ?? dirname(localProfilePath());
}

export function hostIpcEndpointPath(stateDirectory = hostIpcStateDirectory()): string {
  return join(resolve(stateDirectory), "host-endpoint.v1.json");
}

export async function publishHostIpcEndpoint(
  endpoint: PublishedHostIpcEndpointV1,
  stateDirectory = hostIpcStateDirectory(),
): Promise<void> {
  validatePublishedEndpoint(endpoint);
  const target = hostIpcEndpointPath(stateDirectory);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const serialized: SerializedEndpointV1 = {
    ...endpoint,
    capabilities: endpoint.capabilities.map((capability) => ({
      clientKind: capability.clientKind,
      keyId: capability.keyId,
      secret: Buffer.from(capability.secret).toString("base64url"),
    })),
  };
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    await unlink(target);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(target, 0o600).catch(() => undefined);
}

export async function readHostIpcEndpoint(
  clientKind: HostIpcClientKind,
  stateDirectory = hostIpcStateDirectory(),
): Promise<HostIpcClientEndpointV1 | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(hostIpcEndpointPath(stateDirectory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HostIpcProtocolError("Host endpoint is malformed");
  }
  const endpoint = parseSerializedEndpoint(value);
  const capability = endpoint.capabilities.find((candidate) => candidate.clientKind === clientKind);
  if (!capability) throw new HostIpcProtocolError(`Host endpoint has no ${clientKind} capability`);
  return {
    v: endpoint.v,
    instanceId: endpoint.instanceId,
    pipePath: endpoint.pipePath,
    hostPid: endpoint.hostPid,
    brokerPid: endpoint.brokerPid,
    capability,
  };
}

export async function removeHostIpcEndpoint(
  instanceId: string,
  stateDirectory = hostIpcStateDirectory(),
): Promise<void> {
  try {
    const current = parseSerializedEndpoint(
      JSON.parse(await readFile(hostIpcEndpointPath(stateDirectory), "utf8")),
    );
    if (current.instanceId === instanceId) await unlink(hostIpcEndpointPath(stateDirectory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function discardHostIpcEndpoint(
  stateDirectory = hostIpcStateDirectory(),
): Promise<void> {
  await unlink(hostIpcEndpointPath(stateDirectory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function parseSerializedEndpoint(value: unknown): PublishedHostIpcEndpointV1 {
  if (!isRecord(value)) throw new HostIpcProtocolError("Host endpoint must be an object");
  const keys = ["v", "instanceId", "pipePath", "hostPid", "brokerPid", "createdAt", "capabilities"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HostIpcProtocolError("Host endpoint contains unsupported fields");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 2) {
    throw new HostIpcProtocolError("Host endpoint must contain two capabilities");
  }
  const capabilities = value.capabilities.map(parseCapability);
  const endpoint: PublishedHostIpcEndpointV1 = {
    v: value.v as 1,
    instanceId: value.instanceId as string,
    pipePath: value.pipePath as string,
    hostPid: value.hostPid as number,
    brokerPid: value.brokerPid as number,
    createdAt: value.createdAt as string,
    capabilities,
  };
  validatePublishedEndpoint(endpoint);
  if (new Set(capabilities.map((candidate) => candidate.clientKind)).size !== 2) {
    throw new HostIpcProtocolError("Host endpoint capabilities must be distinct");
  }
  return endpoint;
}

function parseCapability(value: unknown): HostIpcCapability {
  if (!isRecord(value) || Object.keys(value).some((key) => !["clientKind", "keyId", "secret"].includes(key))) {
    throw new HostIpcProtocolError("Host endpoint capability is invalid");
  }
  if (value.clientKind !== "mcp" && value.clientKind !== "desktop") {
    throw new HostIpcProtocolError("Host endpoint clientKind is invalid");
  }
  if (typeof value.keyId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.keyId)) {
    throw new HostIpcProtocolError("Host endpoint keyId is invalid");
  }
  if (typeof value.secret !== "string") throw new HostIpcProtocolError("Host endpoint secret is invalid");
  const secret = Buffer.from(value.secret, "base64url");
  if (secret.byteLength !== 32) throw new HostIpcProtocolError("Host endpoint secret is invalid");
  return { clientKind: value.clientKind, keyId: value.keyId, secret };
}

function validatePublishedEndpoint(endpoint: PublishedHostIpcEndpointV1): void {
  if (endpoint.v !== HOST_IPC_PROTOCOL_VERSION) throw new HostIpcProtocolError("Host endpoint version is invalid");
  if (!instancePattern.test(endpoint.instanceId)) throw new HostIpcProtocolError("Host endpoint instanceId is invalid");
  if (endpoint.pipePath !== `${pipePrefix}${endpoint.instanceId}`) {
    throw new HostIpcProtocolError("Host endpoint pipe path is invalid");
  }
  if (!validPid(endpoint.hostPid) || !validPid(endpoint.brokerPid)) {
    throw new HostIpcProtocolError("Host endpoint pid is invalid");
  }
  if (!Number.isFinite(Date.parse(endpoint.createdAt))) {
    throw new HostIpcProtocolError("Host endpoint timestamp is invalid");
  }
  for (const capability of endpoint.capabilities) {
    if (capability.secret.byteLength !== 32) {
      throw new HostIpcProtocolError("Host endpoint capability secret is invalid");
    }
  }
}

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { HostStatusV1 } from "../ipc/ipc-contract.js";

const HOST_STATUS_POLL_MS = 5_000;

export interface HostLifecycleControl {
  drainAndStop(): Promise<void>;
}

export interface DesktopHostStatusControl extends HostLifecycleControl {
  start(): Promise<void>;
  getStatus(): Promise<HostStatusV1>;
  onStatus(listener: (status: HostStatusV1) => void): () => void;
}

export interface SharedDesktopHostClient {
  status(timeoutMs?: number): Promise<SharedHostStatus>;
  gracefulStop(timeoutMs?: number): Promise<void>;
  close(): void;
}

interface SharedHostStatus {
  phase: HostStatusV1["phase"];
  paired: boolean;
  acceptingWork: boolean;
  since: string;
  detail?: string;
}

export type EnsureDesktopHostClient = () => Promise<SharedDesktopHostClient>;

/** Owns one Desktop capability connection; it never starts a second Host itself. */
export class DesktopHostLifecycleControl implements DesktopHostStatusControl {
  private clientPromise: Promise<SharedDesktopHostClient> | null = null;
  private client: SharedDesktopHostClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(status: HostStatusV1) => void>();

  constructor(
    private readonly ensureClient: EnsureDesktopHostClient,
    private readonly pollMilliseconds = HOST_STATUS_POLL_MS,
  ) {}

  async start(): Promise<void> {
    try {
      await this.getStatus();
    } finally {
      this.schedulePoll();
    }
  }

  async getStatus(): Promise<HostStatusV1> {
    const client = await this.connect();
    try {
      const normalized = normalizeStatus(await client.status());
      this.publish(normalized);
      return normalized;
    } catch (error) {
      this.invalidate(client);
      throw error;
    }
  }

  onStatus(listener: (status: HostStatusV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  drainAndStop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const client = this.client;
    const pending = this.clientPromise;
    this.client = null;
    this.clientPromise = null;
    if (!client && pending) {
      void pending.then((connected) => connected.close()).catch(() => undefined);
    }
    this.stopPromise = client
      ? client.gracefulStop().finally(() => client.close())
      : Promise.resolve();
    return this.stopPromise;
  }

  private connect(): Promise<SharedDesktopHostClient> {
    if (this.stopping) {
      return Promise.reject(new Error("desktop_host_is_stopping"));
    }
    if (!this.clientPromise) {
      const pending = this.ensureClient().then((client) => {
        if (this.stopping || this.clientPromise !== pending) {
          client.close();
          throw new Error("desktop_host_is_stopping");
        }
        this.client = client;
        return client;
      });
      this.clientPromise = pending;
      void pending.catch(() => {
        if (this.clientPromise === pending) this.clientPromise = null;
      });
    }
    return this.clientPromise;
  }

  private invalidate(client: SharedDesktopHostClient): void {
    if (this.client !== client) return;
    client.close();
    this.client = null;
    this.clientPromise = null;
  }

  private schedulePoll(): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.getStatus()
        .catch(() => undefined)
        .finally(() => this.schedulePoll());
    }, this.pollMilliseconds);
    this.timer.unref?.();
  }

  private publish(status: HostStatusV1): void {
    for (const listener of this.listeners) listener(status);
  }
}

function normalizeStatus(status: SharedHostStatus): HostStatusV1 {
  if (
    !["unpaired", "active", "draining", "suspended", "catching-up", "failed"].includes(
      status.phase,
    ) ||
    typeof status.paired !== "boolean" ||
    typeof status.acceptingWork !== "boolean" ||
    typeof status.since !== "string" ||
    status.since.length === 0 ||
    (status.detail !== undefined && typeof status.detail !== "string")
  ) {
    throw new Error("invalid_host_status");
  }
  return {
    version: 1,
    phase: status.phase,
    paired: status.paired,
    acceptingWork: status.acceptingWork,
    since: status.since,
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  };
}

import { HostApplication } from "./host-application.js";
import {
  acquireHostRuntimeLock,
  hostRuntimeLockPath,
  releaseHostRuntimeLock,
} from "./host-runtime-lock.js";
import { HostRuntime } from "./host-runtime.js";
import { HostIpcBrokerParent } from "./ipc/broker-parent.js";
import { HostIpcRequestDispatcher } from "./ipc/dispatcher.js";
import {
  publishHostIpcEndpoint,
  removeHostIpcEndpoint,
} from "./ipc/endpoint.js";
import {
  HOST_IPC_PROTOCOL_VERSION,
  type HostIpcResponseV1,
} from "./ipc/protocol.js";

export interface HostServiceOptions {
  brokerPath: string;
  stateDirectory: string;
  reportError?: (scope: string, error: unknown) => void;
}

export class HostServiceStartupError extends Error {
  readonly code = "host_restart_required";
}

export class HostService {
  private stopPromise: Promise<void> | null = null;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;
  private acceptingRequests = true;

  private constructor(
    private readonly runtime: HostRuntime,
    private readonly broker: HostIpcBrokerParent,
    private readonly instanceId: string,
    private readonly stateDirectory: string,
  ) {
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  static async start(options: HostServiceOptions): Promise<HostService> {
    const report = options.reportError ?? ((scope, error) => {
      console.error(scope, error instanceof Error ? error.message : String(error));
    });
    let service: HostService | undefined;
    let dispatcher: HostIpcRequestDispatcher | undefined;
    const { broker, ready } = await HostIpcBrokerParent.start({
      executablePath: options.brokerPath,
      handleRequest: (peer, request) => dispatcher
        ? dispatcher.dispatch(peer, request)
        : Promise.resolve(startingResponse(request.id)),
      afterResponse: (request, response) => {
        if (request.method === "host.gracefulStop" && response.ok) void service?.stop();
      },
      onUnexpectedExit: (error) => {
        report("[codex-collab host IPC]", error);
        void service?.stop();
      },
      reportError: (error) => report("[codex-collab host IPC]", error),
    });
    const lockPath = hostRuntimeLockPath(options.stateDirectory);
    if (!(await acquireHostRuntimeLock(lockPath))) {
      await broker.stop();
      throw new HostServiceStartupError(
        "A legacy Host is still running without a compatible endpoint; restart Codex Collab",
      );
    }

    const application = new HostApplication();
    const runtime = new HostRuntime({ application, reportError: report });
    service = new HostService(runtime, broker, ready.instanceId, options.stateDirectory);
    dispatcher = new HostIpcRequestDispatcher(application, {
      status: async () => {
        const phase = runtime.getPhase();
        return {
          phase,
          paired: (await application.readRuntimeProfile()) !== null,
          acceptingWork: service!.acceptingRequests && phase === "active",
          since: service!.startedAt,
        };
      },
      // Shutdown begins only after broker.response has flushed to the Desktop client.
      gracefulStop: () => undefined,
    });

    try {
      await runtime.start();
      await publishHostIpcEndpoint(
        {
          v: HOST_IPC_PROTOCOL_VERSION,
          instanceId: ready.instanceId,
          pipePath: ready.pipePath,
          hostPid: process.pid,
          brokerPid: ready.brokerPid,
          createdAt: service.startedAt,
          capabilities: ready.capabilities,
        },
        options.stateDirectory,
      );
      for (const capability of ready.capabilities) capability.secret.fill(0);
      return service;
    } catch (error) {
      await service.stop();
      throw error;
    }
  }

  private readonly startedAt = new Date().toISOString();

  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingRequests = false;
    this.stopPromise = (async () => {
      try {
        await this.broker.stop().catch(() => undefined);
        await this.runtime.stop();
      } finally {
        try {
          await removeHostIpcEndpoint(this.instanceId, this.stateDirectory).catch(() => undefined);
        } finally {
          await releaseHostRuntimeLock(hostRuntimeLockPath(this.stateDirectory));
          this.resolveStopped();
        }
      }
    })();
    return this.stopPromise;
  }
}

function startingResponse(id: string): HostIpcResponseV1 {
  return {
    v: HOST_IPC_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: { code: "host_error", message: "Host is still starting" },
  };
}

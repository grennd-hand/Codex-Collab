import type { LocalProfile } from "../local-profile.js";
import type { DurableRecoveryBlockedError } from "../durable-recovery.js";
import type { HostWorkAdmission } from "./host-runtime-admission.js";
import type { HostRuntimePhase } from "./host-runtime-phase.js";
import type {
  RealtimeSocket,
  RealtimeTicketClient,
} from "./host-runtime-realtime.js";

export interface HostRuntimeApplication {
  readRuntimeProfile(): Promise<LocalProfile | null>;
  runBackgroundCycle(admission?: HostWorkAdmission): Promise<void>;
  reconcileAfterResume?(admission?: HostWorkAdmission): Promise<void>;
  cancelActiveWork?(): Promise<void>;
  forwardPendingCommand(admission?: HostWorkAdmission): Promise<string | null>;
  close(): Promise<void>;
  waitForActiveWork?(): Promise<void>;
  setDurableFailureHandler?(
    handler: (error: DurableRecoveryBlockedError) => void,
  ): void;
}

export interface HostRuntimeOptions {
  application: HostRuntimeApplication;
  syncIntervalMs?: number;
  createRelayClient?: (relayUrl: string) => RealtimeTicketClient;
  createRealtimeSocket?: (url: URL) => RealtimeSocket;
  random?: () => number;
  reportError?: (scope: string, error: unknown) => void;
  onPhaseChange?: (phase: HostRuntimePhase) => void;
  cancelTimeoutMs?: number;
}

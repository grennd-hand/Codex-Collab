import { useEffect, useState } from "react";
import type { DashboardRuntimeV1, HostStatusV1 } from "./types.js";

export function useHostStatus(
  runtime: DashboardRuntimeV1,
): HostStatusV1 | null {
  const [status, setStatus] = useState<HostStatusV1 | null>(null);

  useEffect(() => {
    if (runtime.kind !== "desktop") {
      setStatus(null);
      return;
    }
    let stopped = false;
    let receivedEvent = false;
    const unsubscribe = runtime.host.onStatus((next) => {
      if (stopped) return;
      receivedEvent = true;
      setStatus(next);
    });
    void runtime.host.getStatus().then(
      (initial) => {
        if (!stopped && !receivedEvent) setStatus(initial);
      },
      (caught: unknown) => {
        if (stopped || receivedEvent) return;
        setStatus({
          version: 1,
          phase: "failed",
          paired: false,
          acceptingWork: false,
          since: new Date().toISOString(),
          detail: caught instanceof Error ? caught.message : "Host 状态不可用",
        });
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [runtime]);

  return status;
}

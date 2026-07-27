import { Spinner } from "@fluentui/react-components";
import { CheckmarkCircleRegular, DismissRegular, DocumentRegular, HistoryRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { ExecutionStatus } from "./readable-output.js";
import { elapsedExecutionLabel } from "./execution-process-presentation.js";

export function ExecutionElapsedTime({ startedAt }: { startedAt: string }) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    setCurrentTime(Date.now());
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const label = elapsedExecutionLabel(startedAt, currentTime);
  return label ? <span>{label}</span> : null;
}

export function ExecutionStatusIcon({
  status,
  fallback,
}: {
  status: ExecutionStatus;
  fallback: "command" | "reasoning";
}) {
  if (status === "running") return <Spinner size="tiny" />;
  if (status === "completed") return <CheckmarkCircleRegular />;
  if (status === "failed") return <DismissRegular />;
  return fallback === "command" ? <DocumentRegular /> : <HistoryRegular />;
}


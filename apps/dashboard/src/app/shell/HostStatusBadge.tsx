import { Badge } from "@fluentui/react-components";
import type { HostStatusV1 } from "../../shared/runtime/index.js";

export function hostStatusPresentation(status: HostStatusV1): {
  label: string;
  color: "success" | "warning" | "danger" | "informative";
} {
  if (status.phase === "active") {
    return status.acceptingWork
      ? { label: "Host 工作中", color: "success" }
      : { label: "Host 准备中", color: "warning" };
  }
  if (status.phase === "draining") {
    return { label: "Host 正在暂停", color: "warning" };
  }
  if (status.phase === "suspended") {
    return { label: "Host 已休眠", color: "informative" };
  }
  if (status.phase === "catching-up") {
    return { label: "Host 正在同步", color: "informative" };
  }
  if (status.phase === "failed") {
    return { label: "Host 异常", color: "danger" };
  }
  return { label: "Host 未配对", color: "informative" };
}

export function HostStatusBadge({ status }: { status: HostStatusV1 | null }) {
  if (!status) return null;
  const presentation = hostStatusPresentation(status);
  return (
    <Badge
      appearance="tint"
      aria-label={
        status.detail ? `${presentation.label}：${status.detail}` : presentation.label
      }
      title={status.detail ?? presentation.label}
      className="connection-badge host-status-badge"
      color={presentation.color}
      size="large"
    >
      {presentation.label}
    </Badge>
  );
}

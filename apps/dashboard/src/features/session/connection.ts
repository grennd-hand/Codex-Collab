export type ConnectionState =
  | "ready"
  | "connecting"
  | "live"
  | "waiting"
  | "error";

export function connectionPresentation(
  state: ConnectionState,
  hasSession: boolean,
): { label: string; color: "success" | "warning" | "danger" | "informative" } {
  if (!hasSession) {
    return { label: "Relay 就绪", color: "informative" };
  }
  if (state === "live") {
    return { label: "实时连接", color: "success" };
  }
  if (state === "waiting") {
    return { label: "等待批准", color: "warning" };
  }
  if (state === "error") {
    return { label: "需要处理", color: "danger" };
  }
  return { label: "正在连接", color: "informative" };
}

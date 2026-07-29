import type { Message } from "@codex-collab/protocol";

export function deliveryStatusLabel(message: Message): string | null {
  if (message.kind !== "codex_prompt" && message.kind !== "codex_stop") {
    return null;
  }
  if (message.kind === "codex_stop") {
    if (message.deliveryStatus === "submitted") return "停止中";
    if (message.deliveryStatus === "completed") return "已停止";
    if (message.deliveryStatus === "failed") return "停止失败";
    return "停止排队中";
  }
  if (message.deliveryStatus === "submitted") return "执行中";
  if (message.deliveryStatus === "completed") return "执行完成";
  if (message.deliveryStatus === "failed") return "执行失败";
  return "排队中";
}

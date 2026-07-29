import { describe, expect, it } from "vitest";
import { collabTools } from "./mcp-tool-catalog.js";

const expectedToolNames = [
  "collab_health",
  "collab_create_session",
  "collab_recover_session",
  "collab_create_invite",
  "collab_pair_host",
  "collab_refresh_workspace",
  "collab_join_session",
  "collab_status",
  "collab_list_members",
  "collab_approve_member",
  "collab_send_message",
  "collab_list_messages",
  "collab_bind_thread",
  "collab_list_codex_threads",
  "collab_forward_prompt",
  "collab_list_files",
  "collab_read_file",
  "collab_write_file",
] as const;

function requiredFields(name: (typeof expectedToolNames)[number]): readonly string[] {
  const tool = collabTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing MCP tool ${name}`);
  return (tool.inputSchema as { required?: readonly string[] }).required ?? [];
}

describe("Codex Collab MCP tool catalog", () => {
  it("publishes the stable tool set once and in order", () => {
    const names = collabTools.map((tool) => tool.name);
    expect(names).toEqual(expectedToolNames);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps explicit-root and optimistic-write requirements", () => {
    expect(requiredFields("collab_recover_session")).toEqual([
      "sessionId",
      "recoveryKey",
      "projectRoot",
    ]);
    expect(requiredFields("collab_pair_host")).toEqual(["pairingToken", "projectRoot"]);
    expect(requiredFields("collab_bind_thread")).toEqual(["threadId", "projectRoot"]);
    expect(requiredFields("collab_write_file")).toEqual([
      "path",
      "content",
      "expectedSha256",
    ]);
  });
});

import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MessageKind } from "@codex-collab/protocol";
import { CodexAppServerClient } from "./app-server-client.js";
import { FileSandbox } from "./file-sandbox.js";
import { LocalProfileStore, type LocalProfile } from "./local-profile.js";
import { RelayClient } from "./relay-client.js";
import { WorkspaceSyncService } from "./workspace-sync-service.js";
import { ensureWorkspaceSyncWorker } from "./workspace-sync-worker-control.js";

const server = new Server(
  { name: "codex-collab", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
const profiles = new LocalProfileStore();
const codex = new CodexAppServerClient();
const workspaceSync = new WorkspaceSyncService(profiles, codex);

type Arguments = Record<string, unknown>;

const tools = [
  {
    name: "collab_health",
    description: "Check whether the configured Codex Collab relay is reachable.",
    inputSchema: {
      type: "object",
      properties: {
        relayUrl: { type: "string", description: "Optional relay URL override." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "collab_create_session",
    description:
      "Create an owner-controlled collaboration session and bind an explicitly shared project root.",
    inputSchema: {
      type: "object",
      properties: {
        relayUrl: { type: "string", default: "http://127.0.0.1:4177" },
        sessionName: { type: "string" },
        displayName: { type: "string" },
        projectRoot: {
          type: "string",
          description: "Absolute root that collaborators may access. .codex is never implicit.",
        },
        codexConfigRoot: {
          type: "string",
          description:
            "Optional separate absolute path to the .codex directory for non-credential configuration snapshots.",
        },
        threadId: {
          type: "string",
          description: "Optional Codex thread to receive approved peer prompts.",
        },
      },
      required: ["sessionName", "displayName", "projectRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_create_invite",
    description: "Create a short-lived invite. Only the session owner can do this.",
    inputSchema: {
      type: "object",
      properties: {
        expiresInMinutes: { type: "integer", minimum: 5, maximum: 10080, default: 60 },
        maxUses: { type: "integer", minimum: 1, maximum: 20, default: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "collab_pair_host",
    description:
      "Claim a short-lived pairing code from the web room, bind an explicit project root, and publish local Codex tasks for owner selection.",
    inputSchema: {
      type: "object",
      properties: {
        relayUrl: { type: "string", default: "http://127.0.0.1:4177" },
        pairingToken: { type: "string" },
        projectRoot: {
          type: "string",
          description: "Absolute project root to publish. .codex is never implicit.",
        },
        codexConfigRoot: {
          type: "string",
          description:
            "Optional separate absolute path to the .codex directory. Credentials, tokens and session history remain excluded.",
        },
      },
      required: ["pairingToken", "projectRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_refresh_workspace",
    description:
      "Refresh the room's local Codex task catalog and re-import the selected task history plus safe view-only project files.",
    inputSchema: {
      type: "object",
      properties: {
        codexConfigRoot: {
          type: "string",
          description:
            "Optional separate absolute .codex root to add or change for configuration sharing.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "collab_join_session",
    description:
      "Join with an invite token. The member stays pending until the owner explicitly approves.",
    inputSchema: {
      type: "object",
      properties: {
        relayUrl: { type: "string", default: "http://127.0.0.1:4177" },
        inviteToken: { type: "string" },
        displayName: { type: "string" },
        projectRoot: { type: "string" },
      },
      required: ["inviteToken", "displayName", "projectRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_status",
    description:
      "Show the active session, local role, approval status, bound root and bound Codex thread without revealing bearer tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collab_list_members",
    description: "List collaboration members and their approval state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collab_approve_member",
    description:
      "Approve one pending member. Use only after the owner has reviewed and explicitly accepted that member.",
    inputSchema: {
      type: "object",
      properties: { memberId: { type: "string" } },
      required: ["memberId"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_send_message",
    description: "Send a visible identity-labelled chat message or Codex prompt.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", maxLength: 50000 },
        kind: { type: "string", enum: ["chat", "codex_prompt"], default: "chat" },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_list_messages",
    description: "List shared messages in chronological order.",
    inputSchema: {
      type: "object",
      properties: { after: { type: "string", description: "Optional ISO timestamp." } },
      additionalProperties: false,
    },
  },
  {
    name: "collab_bind_thread",
    description: "Bind the active session to a Codex thread ID and an explicit absolute project root.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        projectRoot: { type: "string" },
      },
      required: ["threadId", "projectRoot"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_list_codex_threads",
    description: "Read Codex threads from the local Codex app-server, optionally filtered by cwd.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "collab_forward_prompt",
    description:
      "Forward a stored, approved member's codex_prompt message into the bound owner Codex thread. Owner approval policy is preserved.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_list_files",
    description: "List files under the explicitly bound root. Symlinks and dependency/build folders are skipped.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collab_read_file",
    description: "Read a UTF-8 file under the explicitly bound root and return its optimistic SHA-256.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_write_file",
    description:
      "Atomically write a UTF-8 file under the bound root. expectedSha256 prevents overwriting someone else's newer edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: {
          type: "string",
          description: "Hash returned by collab_read_file, or an empty string for a new file.",
        },
      },
      required: ["path", "content", "expectedSha256"],
      additionalProperties: false,
    },
  },
] as const;

function argsOf(value: unknown): Arguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Arguments;
}

function stringArg(args: Arguments, name: string, optional = false): string | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!optional && value.trim() === "")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function integerArg(args: Arguments, name: string, fallback: number): number {
  const value = args[name] ?? fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function publicProfile(profile: LocalProfile) {
  const { memberToken: _secret, ...safe } = profile;
  return safe;
}

function rootLabel(root: string): string {
  return basename(root) || root;
}

async function createCodexConfigSandbox(root: string): Promise<FileSandbox> {
  const sandbox = await FileSandbox.create(root);
  if (basename(sandbox.getRoot()).toLowerCase() !== ".codex") {
    throw new Error("codexConfigRoot must explicitly point to a .codex directory");
  }
  return sandbox;
}

async function publishCatalog(
  profile: LocalProfile,
  relay: RelayClient,
): Promise<Awaited<ReturnType<RelayClient["publishWorkspaceCatalog"]>>> {
  const sandbox = await FileSandbox.create(profile.projectRoot);
  const threads = await codex.listThreads(sandbox.getRoot());
  const workspace = await relay.publishWorkspaceCatalog(
    profile.sessionId,
    profile.memberToken,
    {
      deviceLabel: hostname(),
      rootLabel: rootLabel(sandbox.getRoot()),
      threads: threads.map((thread) => ({
        id: thread.id,
        name: thread.name ?? null,
        preview: thread.preview?.trim().slice(0, 1_000) ?? "",
        updatedAt:
          typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
            ? thread.updatedAt
            : null,
      })),
    },
  );
  return workspace;
}

async function current(): Promise<{
  profile: LocalProfile;
  relay: RelayClient;
}> {
  const profile = await profiles.read();
  if (!profile) {
    throw new Error(
      "No active session. Use collab_create_session, collab_pair_host or collab_join_session first.",
    );
  }
  return { profile, relay: new RelayClient(profile.relayUrl) };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = argsOf(request.params.arguments);
    switch (request.params.name) {
      case "collab_health": {
        const existing = await profiles.read();
        const relayUrl =
          stringArg(args, "relayUrl", true) ??
          existing?.relayUrl ??
          process.env.CODEX_COLLAB_RELAY_URL ??
          "http://127.0.0.1:4177";
        return text(await new RelayClient(relayUrl).health());
      }
      case "collab_create_session": {
        const relayUrl =
          stringArg(args, "relayUrl", true) ??
          process.env.CODEX_COLLAB_RELAY_URL ??
          "http://127.0.0.1:4177";
        const projectRoot = stringArg(args, "projectRoot")!;
        const projectSandbox = await FileSandbox.create(projectRoot);
        const codexConfigRoot = stringArg(args, "codexConfigRoot", true);
        const codexConfigSandbox = codexConfigRoot
          ? await createCodexConfigSandbox(codexConfigRoot)
          : null;
        const relay = new RelayClient(relayUrl);
        const created = await relay.createSession({
          name: stringArg(args, "sessionName")!,
          ownerDisplayName: stringArg(args, "displayName")!,
          deviceLabel: hostname(),
        });
        const threadId = stringArg(args, "threadId", true);
        const profile: LocalProfile = {
          relayUrl,
          sessionId: created.session.id,
          memberId: created.owner.id,
          displayName: created.owner.displayName,
          role: "owner",
          memberToken: created.memberToken,
          projectRoot: projectSandbox.getRoot(),
          ...(codexConfigSandbox ? { codexConfigRoot: codexConfigSandbox.getRoot() } : {}),
          ...(threadId ? { threadId } : {}),
          forwardedMessageIds: [],
        };
        await profiles.write(profile);
        return text({ session: created.session, profile: publicProfile(profile) });
      }
      case "collab_create_invite": {
        const { profile, relay } = await current();
        const invite = await relay.createInvite(profile.sessionId, profile.memberToken, {
          expiresInMinutes: integerArg(args, "expiresInMinutes", 60),
          maxUses: integerArg(args, "maxUses", 1),
        });
        return text(invite);
      }
      case "collab_pair_host": {
        const relayUrl =
          stringArg(args, "relayUrl", true) ??
          process.env.CODEX_COLLAB_RELAY_URL ??
          "http://127.0.0.1:4177";
        const sandbox = await FileSandbox.create(stringArg(args, "projectRoot")!);
        const codexConfigRoot = stringArg(args, "codexConfigRoot", true);
        const codexConfigSandbox = codexConfigRoot
          ? await createCodexConfigSandbox(codexConfigRoot)
          : null;
        const relay = new RelayClient(relayUrl);
        const claimed = await relay.claimHostPairing({
          pairingToken: stringArg(args, "pairingToken")!,
          deviceLabel: hostname(),
          rootLabel: rootLabel(sandbox.getRoot()),
        });
        const profile: LocalProfile = {
          relayUrl,
          sessionId: claimed.session.id,
          memberId: claimed.owner.id,
          displayName: claimed.owner.displayName,
          role: "owner",
          memberToken: claimed.memberToken,
          projectRoot: sandbox.getRoot(),
          ...(codexConfigSandbox ? { codexConfigRoot: codexConfigSandbox.getRoot() } : {}),
          forwardedMessageIds: [],
        };
        await profiles.write(profile);
        const workspace = await publishCatalog(profile, relay);
        await profiles.update({
          observedThreadIds: workspace.threads.map((thread) => thread.id),
        });
        return text({
          session: claimed.session,
          profile: publicProfile(profile),
          publishedTaskCount: workspace.threads.length,
          next: "Choose a Codex task in the room's Codex 与文件 panel. It will import automatically while this host is running.",
        });
      }
      case "collab_refresh_workspace": {
        const currentSession = await current();
        let { profile } = currentSession;
        const { relay } = currentSession;
        if (profile.role !== "owner") {
          throw new Error("Only the owner host can publish a workspace");
        }
        const codexConfigRoot = stringArg(args, "codexConfigRoot", true);
        if (codexConfigRoot) {
          const codexConfigSandbox = await createCodexConfigSandbox(codexConfigRoot);
          profile = await profiles.update({
            codexConfigRoot: codexConfigSandbox.getRoot(),
          });
        }
        const workspace = await publishCatalog(profile, relay);
        const imported = await workspaceSync.sync(true);
        return text({
          publishedTaskCount: workspace.threads.length,
          ...imported,
        });
      }
      case "collab_join_session": {
        const relayUrl =
          stringArg(args, "relayUrl", true) ??
          process.env.CODEX_COLLAB_RELAY_URL ??
          "http://127.0.0.1:4177";
        const projectRoot = stringArg(args, "projectRoot")!;
        await FileSandbox.create(projectRoot);
        const relay = new RelayClient(relayUrl);
        const joined = await relay.joinInvite({
          inviteToken: stringArg(args, "inviteToken")!,
          displayName: stringArg(args, "displayName")!,
          deviceLabel: hostname(),
        });
        const profile: LocalProfile = {
          relayUrl,
          sessionId: joined.session.id,
          memberId: joined.member.id,
          displayName: joined.member.displayName,
          role: joined.member.role,
          memberToken: joined.memberToken,
          projectRoot,
          forwardedMessageIds: [],
        };
        await profiles.write(profile);
        return text({ session: joined.session, member: joined.member, approvalRequired: true });
      }
      case "collab_status": {
        const { profile, relay } = await current();
        const [health, member] = await Promise.all([
          relay.health(),
          relay.currentMember(profile.sessionId, profile.memberToken),
        ]);
        return text({ relay: health, member, profile: publicProfile(profile) });
      }
      case "collab_list_members": {
        const { profile, relay } = await current();
        return text(await relay.listMembers(profile.sessionId, profile.memberToken));
      }
      case "collab_approve_member": {
        const { profile, relay } = await current();
        if (profile.role !== "owner") throw new Error("Only the owner can approve members");
        return text(
          await relay.approveMember(
            profile.sessionId,
            profile.memberToken,
            stringArg(args, "memberId")!,
          ),
        );
      }
      case "collab_send_message": {
        const { profile, relay } = await current();
        const kind = (stringArg(args, "kind", true) ?? "chat") as MessageKind;
        if (kind !== "chat" && kind !== "codex_prompt") {
          throw new Error("kind must be chat or codex_prompt");
        }
        return text(
          await relay.sendMessage(
            profile.sessionId,
            profile.memberToken,
            kind,
            stringArg(args, "body")!,
          ),
        );
      }
      case "collab_list_messages": {
        const { profile, relay } = await current();
        const messages = await relay.listMessages(
          profile.sessionId,
          profile.memberToken,
          stringArg(args, "after", true),
        );
        if (messages.length > 0) {
          const lastMessage = messages.at(-1);
          if (lastMessage) {
            await profiles.update({ lastMessageAt: lastMessage.createdAt });
          }
        }
        return text(messages);
      }
      case "collab_bind_thread": {
        const projectRoot = stringArg(args, "projectRoot")!;
        if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
        await FileSandbox.create(projectRoot);
        return text(
          publicProfile(
            await profiles.update({
              threadId: stringArg(args, "threadId")!,
              projectRoot,
              observedThreadIds: undefined,
            }),
          ),
        );
      }
      case "collab_list_codex_threads": {
        return text(await codex.listThreads(stringArg(args, "cwd", true)));
      }
      case "collab_forward_prompt": {
        const { profile, relay } = await current();
        if (profile.role !== "owner") throw new Error("Only the owner host can forward prompts");
        if (!profile.threadId) throw new Error("Bind a Codex thread first");
        const messageId = stringArg(args, "messageId")!;
        if (profile.forwardedMessageIds?.includes(messageId)) {
          throw new Error("This collaboration message was already forwarded");
        }
        const messages = await relay.listMessages(profile.sessionId, profile.memberToken);
        const message = messages.find((candidate) => candidate.id === messageId);
        if (!message) throw new Error("Message was not found in the approved session");
        if (message.kind !== "codex_prompt") {
          throw new Error("Only codex_prompt messages can be forwarded");
        }
        const selectedThread = (
          await codex.listThreads(profile.projectRoot)
        ).find((thread) => thread.id === profile.threadId);
        if (!selectedThread) {
          throw new Error(
            "Bound Codex task no longer belongs to the explicitly shared root",
          );
        }
        const result = await codex.submitPeerPrompt({
          threadId: profile.threadId,
          projectRoot: profile.projectRoot,
          commandId: message.id,
          peerDisplayName: message.senderDisplayName,
          body: message.body,
          attachments: await Promise.all(
            message.attachments.map(async (attachment) => ({
              name: attachment.name,
              mediaType: attachment.mediaType,
              content: await relay.readMessageAttachment(
                profile.sessionId,
                profile.memberToken,
                message.id,
                attachment,
              ),
            })),
          ),
          codexOptions: message.codexOptions ?? {
            accessMode: "follow-desktop",
            customPermissions: null,
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
        });
        if (result.status !== "submitted") {
          throw new Error(
            `Codex app-server did not submit the prompt (${result.reason ?? "not-ready"}). The prompt remains queued.`,
          );
        }
        const forwardedMessageIds = [...(profile.forwardedMessageIds ?? []), message.id];
        await profiles.update({ forwardedMessageIds });
        await relay.updateMessageDeliveryStatus(
          profile.sessionId,
          profile.memberToken,
          message.id,
          "submitted",
          result.turnId ?? null,
        );
        return text({ forwarded: message, appServerSubmission: result });
      }
      case "collab_list_files": {
        const { profile } = await current();
        const sandbox = await FileSandbox.create(profile.projectRoot);
        return text({ root: sandbox.getRoot(), files: await sandbox.list() });
      }
      case "collab_read_file": {
        const { profile } = await current();
        const sandbox = await FileSandbox.create(profile.projectRoot);
        return text(await sandbox.read(stringArg(args, "path")!));
      }
      case "collab_write_file": {
        const { profile } = await current();
        const sandbox = await FileSandbox.create(profile.projectRoot);
        return text(
          await sandbox.write(
            stringArg(args, "path")!,
            stringArg(args, "content", true) ?? "",
            stringArg(args, "expectedSha256", true) ?? "",
          ),
        );
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

server.onerror = (error) => {
  console.error("[codex-collab MCP]", error);
};

process.on("SIGINT", async () => {
  await codex.close();
  await server.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
ensureWorkspaceSyncWorker();

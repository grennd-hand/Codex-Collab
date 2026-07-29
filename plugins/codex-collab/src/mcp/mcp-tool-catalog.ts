export const collabTools = [
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
    name: "collab_recover_session",
    description:
      "Recover reusable owner access with a room ID and owner recovery key, then bind an explicitly shared project root.",
    inputSchema: {
      type: "object",
      properties: {
        relayUrl: { type: "string", default: "http://127.0.0.1:4177" },
        sessionId: { type: "string" },
        recoveryKey: { type: "string" },
        projectRoot: {
          type: "string",
          description: "Absolute root that collaborators may access. .codex is never implicit.",
        },
        codexConfigRoot: {
          type: "string",
          description:
            "Optional separate absolute path to the .codex directory for non-credential configuration snapshots.",
        },
        threadId: { type: "string" },
      },
      required: ["sessionId", "recoveryKey", "projectRoot"],
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

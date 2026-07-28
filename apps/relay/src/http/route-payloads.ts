import { createHash } from "node:crypto";
import {
  optionalInteger,
  requiredString,
  MAX_MESSAGE_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENT_SIZE,
  MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE,
  MAX_WORKSPACE_HISTORY_ENTRIES,
  MAX_WORKSPACE_HISTORY_TEXT_LENGTH,
  type CodexRecordEntry,
  type CodexThreadCatalogEntry,
  type MessageAttachmentInput,
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  type WorkspaceFileOperationEvent,
  isPublishableWorkspaceDirectoryPath,
  ProtocolError,
} from "@codex-collab/protocol";
import { parseCodexFileChanges } from "./codex-file-change-payloads.js";

export { parseCodexFileChanges } from "./codex-file-change-payloads.js";

export function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseThreadCatalog(value: unknown): CodexThreadCatalogEntry[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProtocolError(400, "invalid_request", "threads must contain at most 100 tasks");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `threads[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const updatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : null;
    return {
      id: requiredString(record.id, `threads[${index}].id`, 120),
      name:
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim().slice(0, 200)
          : null,
      preview:
        typeof record.preview === "string" ? record.preview.trim().slice(0, 1_000) : "",
      updatedAt,
    };
  });
}

export function parseHistory(value: unknown): CodexRecordEntry[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_HISTORY_ENTRIES) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `history must contain at most ${MAX_WORKSPACE_HISTORY_ENTRIES} entries`,
    );
  }
  let totalLength = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `history[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      record.role !== "user" &&
      record.role !== "assistant" &&
      record.role !== "reasoning" &&
      record.role !== "command"
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `history[${index}].role is invalid`,
      );
    }
    const text = requiredString(record.text, `history[${index}].text`, 50_000);
    const phase =
      record.role === "assistant" &&
      (record.phase === "commentary" || record.phase === "final_answer")
        ? record.phase
        : null;
    const fileChanges = parseCodexFileChanges(record.fileChanges, index);
    totalLength += text.length + JSON.stringify(fileChanges ?? []).length;
    if (totalLength > MAX_WORKSPACE_HISTORY_TEXT_LENGTH) {
      throw new ProtocolError(413, "history_too_large", "Imported Codex history is too large");
    }
    return {
      id: requiredString(record.id, `history[${index}].id`, 160),
      role: record.role,
      ...(phase ? { phase } : {}),
      text,
      createdAt:
        typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
          ? new Date(record.createdAt).toISOString()
          : null,
      ...(fileChanges?.length ? { fileChanges } : {}),
    };
  });
}

export function parseWorkspaceFiles(value: unknown): WorkspaceFileContent[] {
  if (!Array.isArray(value) || value.length > 600) {
    throw new ProtocolError(400, "invalid_request", "files must contain at most 600 files");
  }
  let totalLength = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `files[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const path = requiredString(record.path, `files[${index}].path`, 500).replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").some((segment) => segment === "..")) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].path is unsafe`);
    }
    const content =
      typeof record.content === "string"
        ? record.content
        : (() => {
            throw new ProtocolError(
              400,
              "invalid_request",
              `files[${index}].content must be a string`,
            );
          })();
    totalLength += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > 256_000 || totalLength > 5_000_000) {
      throw new ProtocolError(413, "workspace_too_large", "Shared file snapshot is too large");
    }
    const size = record.size;
    if (!Number.isInteger(size) || (size as number) < 0 || (size as number) > 256_000) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].size is invalid`);
    }
    if (size !== Buffer.byteLength(content)) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `files[${index}].size does not match its content`,
      );
    }
    const sha256 = requiredString(record.sha256, `files[${index}].sha256`, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].sha256 is invalid`);
    }
    if (createHash("sha256").update(content).digest("hex") !== sha256) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `files[${index}].sha256 does not match its content`,
      );
    }
    const modifiedAt = requiredString(record.modifiedAt, `files[${index}].modifiedAt`, 40);
    if (Number.isNaN(Date.parse(modifiedAt))) {
      throw new ProtocolError(400, "invalid_request", `files[${index}].modifiedAt is invalid`);
    }
    return {
      path,
      content,
      size: size as number,
      sha256,
      modifiedAt: new Date(modifiedAt).toISOString(),
    };
  });
}

export function parseWorkspaceDirectories(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2_000) {
    throw new ProtocolError(
      400,
      "invalid_request",
      "directories must contain at most 2000 paths",
    );
  }
  return [...new Set(value.map((item, index) => {
    const path = requiredString(item, `directories[${index}]`, 500)
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    if (!isPublishableWorkspaceDirectoryPath(path)) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `directories[${index}] is unsafe`,
      );
    }
    return path;
  }))];
}

export function parseWorkspaceFileOperationRequest(
  body: Record<string, unknown>,
):
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string; expectedSha256: string }
  | { kind: "mkdir"; path: string }
  | { kind: "rename"; path: string; destinationPath: string; expectedSha256: string | null } {
  const path = requiredString(body.path, "path", 500);
  if (body.kind === "read") {
    if (body.content !== undefined || body.expectedSha256 !== undefined) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "Read operations do not accept content or expectedSha256",
      );
    }
    return { kind: "read", path };
  }
  if (body.kind === "mkdir") {
    if (body.content !== undefined || body.expectedSha256 !== undefined) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "Directory operations do not accept content or expectedSha256",
      );
    }
    return { kind: "mkdir", path };
  }
  if (body.kind === "rename") {
    const destinationPath = requiredString(body.destinationPath, "destinationPath", 500);
    if (
      body.content !== undefined ||
      (body.expectedSha256 !== null && typeof body.expectedSha256 !== "string")
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "Rename requires destinationPath and a file hash or null",
      );
    }
    return {
      kind: "rename",
      path,
      destinationPath,
      expectedSha256: body.expectedSha256 as string | null,
    };
  }
  if (body.kind !== "write") {
    throw new ProtocolError(
      400,
      "invalid_request",
      "kind must be read, write, mkdir, or rename",
    );
  }
  if (typeof body.content !== "string") {
    throw new ProtocolError(400, "invalid_request", "content must be a string");
  }
  if (typeof body.expectedSha256 !== "string") {
    throw new ProtocolError(
      400,
      "invalid_request",
      "expectedSha256 is required for every write",
    );
  }
  return {
    kind: "write",
    path,
    content: body.content,
    expectedSha256: body.expectedSha256,
  };
}

export function parseWorkspaceOperationResultFile(value: unknown): WorkspaceFileContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_request", "file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.content !== "string") {
    throw new ProtocolError(400, "invalid_request", "file.content must be a string");
  }
  if (!Number.isInteger(record.size) || (record.size as number) < 0) {
    throw new ProtocolError(400, "invalid_request", "file.size is invalid");
  }
  return {
    path: requiredString(record.path, "file.path", 500),
    content: record.content,
    size: record.size as number,
    modifiedAt: requiredString(record.modifiedAt, "file.modifiedAt", 40),
    sha256: requiredString(record.sha256, "file.sha256", 64),
  };
}

export function toWorkspaceFileOperationEvent(
  operation: WorkspaceFileOperation,
): WorkspaceFileOperationEvent {
  return {
    operationId: operation.id,
    requestedByMemberId: operation.requestedByMemberId,
    status: operation.status,
  };
}

export function parseMessageAttachments(value: unknown): Array<{
  name: string;
  mediaType: string;
  size: number;
  content: Uint8Array;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ATTACHMENT_COUNT) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `attachments must contain at most ${MAX_MESSAGE_ATTACHMENT_COUNT} files`,
    );
  }
  let totalSize = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}] must be an object`);
    }
    const record = item as Partial<MessageAttachmentInput> & Record<string, unknown>;
    const name = requiredString(record.name, `attachments[${index}].name`, 180);
    if (
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      /[<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      /[\u0000-\u001f]/.test(name)
    ) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}].name is unsafe`);
    }
    const mediaType =
      typeof record.mediaType === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
        record.mediaType,
      )
        ? record.mediaType
        : "application/octet-stream";
    if (
      !Number.isInteger(record.size) ||
      (record.size as number) < 0 ||
      (record.size as number) > MAX_MESSAGE_ATTACHMENT_SIZE
    ) {
      throw new ProtocolError(400, "invalid_request", `attachments[${index}].size is invalid`);
    }
    if (
      typeof record.dataBase64 !== "string" ||
      record.dataBase64.length === 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(record.dataBase64)
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `attachments[${index}].dataBase64 is invalid`,
      );
    }
    const content = Buffer.from(record.dataBase64, "base64");
    if (content.length !== record.size) {
      throw new ProtocolError(
        400,
        "invalid_request",
        `attachments[${index}].size does not match its content`,
      );
    }
    totalSize += content.length;
    if (totalSize > MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE) {
      throw new ProtocolError(
        413,
        "attachments_too_large",
        `Attachments exceed the ${MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE / 1_000_000} MB limit`,
      );
    }
    return {
      name,
      mediaType,
      size: content.length,
      content,
    };
  });
}

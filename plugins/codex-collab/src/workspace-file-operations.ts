import type {
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceFileOperationClaim,
} from "@codex-collab/protocol";
import { FileConflictError, FileSandbox } from "./file-sandbox.js";
import type { RelayClient } from "./relay-client.js";

type FileOperationRelay = Pick<
  RelayClient,
  "claimNextWorkspaceFileOperation" | "completeWorkspaceFileOperation"
>;

function isPrivateWebEditorPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) =>
      [".codex", ".codex-collab", ".git", ".runtime-data"].includes(segment),
    ) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    [
      ".netrc",
      ".npmrc",
      ".pypirc",
      "auth.json",
      "auth.toml",
      "cookies.json",
      "credentials.json",
      "id_ed25519",
      "id_rsa",
      "secrets.json",
      "tokens.json",
    ].includes(name) ||
    name.startsWith("service-account")
  );
}

function asWorkspaceFile(file: Awaited<ReturnType<FileSandbox["read"]>>): WorkspaceFileContent {
  return {
    path: file.path,
    content: file.content,
    size: file.size,
    modifiedAt: file.modifiedAt,
    sha256: file.sha256,
  };
}

function failureCode(error: unknown): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "workspace_file_not_found";
  if (error instanceof FileConflictError) return "file_conflict";
  const message = error instanceof Error ? error.message : String(error);
  if (/outside|symbolic link|approved root|relative path/i.test(message)) {
    return "unsafe_workspace_path";
  }
  if (/2 MB/i.test(message)) return "workspace_file_too_large";
  if (/UTF-8 text|text files only/i.test(message)) {
    return "workspace_binary_file_unsupported";
  }
  return "workspace_file_operation_failed";
}

function safeFailureMessage(code: string): string {
  switch (code) {
    case "workspace_file_not_found":
      return "The requested file does not exist on the host";
    case "file_conflict":
      return "The file changed on the host after it was opened";
    case "unsafe_workspace_path":
      return "The requested path is outside the approved workspace boundary";
    case "workspace_file_too_large":
      return "The file exceeds the 2 MB collaboration limit";
    case "workspace_binary_file_unsupported":
      return "The collaboration editor supports UTF-8 text files only";
    default:
      return "The host could not complete the file operation";
  }
}

async function currentFile(
  sandbox: FileSandbox,
  path: string,
): Promise<WorkspaceFileContent | null> {
  try {
    return asWorkspaceFile(await sandbox.read(path));
  } catch {
    return null;
  }
}

export async function executeWorkspaceFileOperation(
  operation: WorkspaceFileOperationClaim,
  sandbox: FileSandbox,
): Promise<
  | { status: "completed"; file: WorkspaceFileContent }
  | {
      status: "failed";
      errorCode: string;
      errorMessage: string;
      file?: WorkspaceFileContent | null;
    }
> {
  if (isPrivateWebEditorPath(operation.path)) {
    return {
      status: "failed",
      errorCode: "workspace_path_not_shared",
      errorMessage: "This private path is not shared with the web editor",
    };
  }

  try {
    if (operation.kind === "read") {
      return {
        status: "completed",
        file: asWorkspaceFile(await sandbox.read(operation.path)),
      };
    }
    if (operation.requestContent === null || operation.expectedSha256 === null) {
      return {
        status: "failed",
        errorCode: "invalid_workspace_operation",
        errorMessage: "The queued write operation is missing required data",
      };
    }
    return {
      status: "completed",
      file: asWorkspaceFile(
        await sandbox.write(
          operation.path,
          operation.requestContent,
          operation.expectedSha256,
        ),
      ),
    };
  } catch (error) {
    if (error instanceof FileConflictError) {
      const file = await currentFile(sandbox, operation.path);
      if (file?.content === operation.requestContent) {
        return { status: "completed", file };
      }
      return {
        status: "failed",
        errorCode: "file_conflict",
        errorMessage: safeFailureMessage("file_conflict"),
        ...(file ? { file } : {}),
      };
    }
    const errorCode = failureCode(error);
    return {
      status: "failed",
      errorCode,
      errorMessage: safeFailureMessage(errorCode),
    };
  }
}

export async function processNextWorkspaceFileOperation(
  sessionId: string,
  memberToken: string,
  relay: FileOperationRelay,
  sandbox: FileSandbox,
): Promise<WorkspaceFileOperation | null> {
  const operation = await relay.claimNextWorkspaceFileOperation(sessionId, memberToken);
  if (!operation) return null;
  const result = await executeWorkspaceFileOperation(operation, sandbox);
  return relay.completeWorkspaceFileOperation(
    sessionId,
    memberToken,
    operation.id,
    result,
  );
}

import type {
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceFileOperationClaim,
} from "@codex-collab/protocol";
import {
  codexConfigRelativePath,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
  isWorkspacePathIgnored,
} from "@codex-collab/protocol";
import { FileConflictError, FileSandbox } from "./file-sandbox.js";
import type { RelayClient } from "./relay-client.js";
import { readCollabIgnore } from "./workspace-snapshot.js";

type FileOperationRelay = Pick<
  RelayClient,
  | "claimNextWorkspaceFileOperation"
  | "confirmWorkspaceFileOperationLease"
  | "completeWorkspaceFileOperation"
>;

function asWorkspaceFile(
  file: Awaited<ReturnType<FileSandbox["read"]>>,
  publicPath = file.path,
): WorkspaceFileContent {
  return {
    path: publicPath,
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
    const file = asWorkspaceFile(await sandbox.read(path));
    return containsLikelySecret(file.content) ? null : file;
  } catch {
    return null;
  }
}

export async function executeWorkspaceFileOperation(
  operation: WorkspaceFileOperationClaim,
  projectSandbox: FileSandbox,
  codexConfigSandbox: FileSandbox | null = null,
): Promise<
  | { status: "completed"; file: WorkspaceFileContent }
  | {
      status: "failed";
      errorCode: string;
      errorMessage: string;
      file?: WorkspaceFileContent | null;
    }
> {
  const configRelativePath = codexConfigRelativePath(operation.path);
  if (configRelativePath) {
    if (
      operation.kind !== "read" ||
      !codexConfigSandbox ||
      !isPublishableCodexConfigPath(configRelativePath)
    ) {
      return {
        status: "failed",
        errorCode: "workspace_file_not_shared",
        errorMessage: "This file is not available to the collaboration editor",
      };
    }
    try {
      const file = asWorkspaceFile(
        await codexConfigSandbox.read(configRelativePath),
        `.codex/${configRelativePath}`,
      );
      if (containsLikelySecret(file.content)) {
        return {
          status: "failed",
          errorCode: "workspace_file_not_shared",
          errorMessage: "This file is not available to the collaboration editor",
        };
      }
      return { status: "completed", file };
    } catch (error) {
      const errorCode = failureCode(error);
      return {
        status: "failed",
        errorCode,
        errorMessage: safeFailureMessage(errorCode),
      };
    }
  }

  const ignoredPaths = await readCollabIgnore(projectSandbox);
  if (
    !isPublishableWorkspacePath(operation.path) ||
    isWorkspacePathIgnored(operation.path, ignoredPaths, process.platform === "win32")
  ) {
    return {
      status: "failed",
      errorCode: "workspace_file_not_shared",
      errorMessage: "This file is not available to the collaboration editor",
    };
  }

  try {
    if (operation.kind === "read") {
      const file = asWorkspaceFile(await projectSandbox.read(operation.path));
      if (containsLikelySecret(file.content)) {
        return {
          status: "failed",
          errorCode: "workspace_file_not_shared",
          errorMessage: "This file is not available to the collaboration editor",
        };
      }
      return {
        status: "completed",
        file,
      };
    }
    if (operation.requestContent === null || operation.expectedSha256 === null) {
      return {
        status: "failed",
        errorCode: "invalid_workspace_operation",
        errorMessage: "The queued write operation is missing required data",
      };
    }
    if (containsLikelySecret(operation.requestContent)) {
      return {
        status: "failed",
        errorCode: "workspace_file_not_shared",
        errorMessage: "This file is not available to the collaboration editor",
      };
    }
    return {
      status: "completed",
      file: asWorkspaceFile(
        await projectSandbox.write(
          operation.path,
          operation.requestContent,
          operation.expectedSha256,
        ),
      ),
    };
  } catch (error) {
    if (error instanceof FileConflictError) {
      const file = await currentFile(projectSandbox, operation.path);
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
  projectSandbox: FileSandbox,
  codexConfigSandbox: FileSandbox | null = null,
): Promise<WorkspaceFileOperation | null> {
  const operation = await relay.claimNextWorkspaceFileOperation(sessionId, memberToken);
  if (!operation) return null;
  const confirmed = await relay.confirmWorkspaceFileOperationLease(
    sessionId,
    memberToken,
    operation.id,
    operation.leaseId,
  );
  const result = await executeWorkspaceFileOperation(
    confirmed,
    projectSandbox,
    codexConfigSandbox,
  );
  return relay.completeWorkspaceFileOperation(
    sessionId,
    memberToken,
    confirmed.id,
    { ...result, leaseId: confirmed.leaseId },
  );
}

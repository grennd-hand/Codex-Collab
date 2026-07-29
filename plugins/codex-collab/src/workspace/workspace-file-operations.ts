import type {
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceFileOperationConfirmation,
} from "@codex-collab/protocol";
import {
  codexConfigRelativePath,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspaceDirectoryPath,
  isPublishableWorkspacePath,
  isWorkspacePathIgnored,
} from "@codex-collab/protocol";
import { FileConflictError, FileSandbox } from "./sandbox/file-sandbox.js";
import type {
  LocalFileOperationResult,
  LocalProfile,
  LocalProfileStore,
} from "../persistence/local-profile.js";
import type { RelayClient } from "../relay/relay-client.js";
import { WorkspaceFileOperationJournal } from "./workspace-file-operation-receipts.js";
import {
  workspaceWorkAllowed,
  type WorkspaceSyncAdmission,
} from "../sync/workspace-sync-admission.js";
import { readCollabIgnore } from "./workspace-snapshot.js";

type FileOperationRelay = Pick<
  RelayClient,
  | "claimNextWorkspaceFileOperation"
  | "confirmWorkspaceFileOperationLease"
  | "completeWorkspaceFileOperation"
  | "releaseWorkspaceFileOperationLease"
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
  if (/already exists|occupied by a file/i.test(message)) return "file_conflict";
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
  operation: WorkspaceFileOperationConfirmation,
  projectSandbox: FileSandbox,
  codexConfigSandbox: FileSandbox | null = null,
): Promise<LocalFileOperationResult> {
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
  const directoryOperation =
    operation.kind === "mkdir" ||
    (operation.kind === "rename" && operation.expectedSha256 === null);
  const publishable = directoryOperation
    ? isPublishableWorkspaceDirectoryPath
    : isPublishableWorkspacePath;
  const operationPaths = operation.kind === "rename"
    ? [operation.path, operation.destinationPath ?? ""]
    : [operation.path];
  if (
    operationPaths.some(
      (path) =>
        !publishable(path) ||
        isWorkspacePathIgnored(path, ignoredPaths, process.platform === "win32"),
    )
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
    if (operation.kind === "mkdir") {
      await projectSandbox.createDirectory(operation.path);
      return { status: "completed" };
    }
    if (operation.kind === "rename") {
      if (!operation.destinationPath) {
        return {
          status: "failed",
          errorCode: "invalid_workspace_operation",
          errorMessage: "The queued rename operation is missing its destination",
        };
      }
      if (operation.expectedSha256 !== null) {
        const source = await projectSandbox.read(operation.path);
        if (containsLikelySecret(source.content)) {
          return {
            status: "failed",
            errorCode: "workspace_file_not_shared",
            errorMessage: "This file is not available to the collaboration editor",
          };
        }
      }
      const file = await projectSandbox.rename(
        operation.path,
        operation.destinationPath,
        operation.expectedSha256,
      );
      return file ? { status: "completed", file: asWorkspaceFile(file) } : { status: "completed" };
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
    if (operation.expectedSha256 !== "") {
      const existing = await projectSandbox.read(operation.path);
      if (containsLikelySecret(existing.content)) {
        return {
          status: "failed",
          errorCode: "workspace_file_not_shared",
          errorMessage: "This file is not available to the collaboration editor",
        };
      }
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
      if (operation.kind === "rename") {
        return {
          status: "failed",
          errorCode: "file_conflict",
          errorMessage: safeFailureMessage("file_conflict"),
        };
      }
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
  profile: LocalProfile,
  profiles: LocalProfileStore,
  relay: FileOperationRelay,
  projectSandbox: FileSandbox,
  codexConfigSandbox: FileSandbox | null = null,
  admission?: WorkspaceSyncAdmission,
): Promise<WorkspaceFileOperation | null> {
  if (!workspaceWorkAllowed(admission)) return null;
  const journal = new WorkspaceFileOperationJournal(profiles, profile);
  const replayed = await journal.reconcileBeforeClaim(relay);
  if (replayed) return replayed;
  if (!workspaceWorkAllowed(admission)) return null;
  const operation = await relay.claimNextWorkspaceFileOperation(
    profile.sessionId,
    profile.memberToken,
  );
  if (!operation) return null;
  const confirmed = await relay.confirmWorkspaceFileOperationLease(
    profile.sessionId,
    profile.memberToken,
    operation.id,
    operation.leaseId,
  );
  const intent = await journal.recordIntent(operation, confirmed);
  if (!workspaceWorkAllowed(admission)) {
    await journal.releaseIntent(relay, intent, confirmed);
    return null;
  }
  const executing = await journal.markExecuting(intent, confirmed);
  const result = await executeWorkspaceFileOperation(
    confirmed,
    projectSandbox,
    codexConfigSandbox,
  );
  await journal.recordResult(executing, confirmed, result);
  return journal.reconcileBeforeClaim(relay);
}

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  runWindowsFileCas,
  type WindowsFileCasDebugOptions,
} from "./windows-file-cas.js";
import {
  createSafeWorkspaceDirectory,
  SKIPPED_WORKSPACE_DIRECTORIES,
} from "./workspace-directory-sandbox.js";
import {
  renameSandboxEntry,
  SandboxRenameConflictError,
} from "./file-sandbox-rename.js";

export interface SharedFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ReadSharedFile {
  path: string;
  content: string;
  size: number;
  sha256: string;
  modifiedAt: string;
}

export class FileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileConflictError";
  }
}

export interface FileSandboxTestHooks {
  beforeFinalWriteCheck?: (path: string) => Promise<void>;
  beforeCandidateOpen?: (path: string) => Promise<void>;
  platform?: NodeJS.Platform;
  windowsCasDebug?: WindowsFileCasDebugOptions;
}

const pathWriteLocks = new Map<string, Promise<void>>();
const RECOVERY_TRANSACTION_LIMIT = 32;
const RECOVERY_BYTE_LIMIT = 64_000_000;

function normalizedIgnoredPaths(paths: readonly string[]): string[] {
  return paths
    .map((path) =>
      path
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .replace(/^\/+|\/+$/g, ""),
    )
    .filter(Boolean);
}

function pathIsIgnored(path: string, ignoredPaths: readonly string[]): boolean {
  const normalizeCase = (value: string) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const comparablePath = normalizeCase(path);
  return ignoredPaths.some((ignored) => {
    const comparableIgnored = normalizeCase(ignored);
    return (
      comparablePath === comparableIgnored ||
      comparablePath.startsWith(`${comparableIgnored}/`)
    );
  });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class FileSandbox {
  private constructor(
    private readonly root: string,
    private readonly testHooks: FileSandboxTestHooks,
  ) {}

  static async create(
    root: string,
    testHooks: FileSandboxTestHooks = {},
  ): Promise<FileSandbox> {
    if (!isAbsolute(root)) {
      throw new Error("Shared root must be an absolute path");
    }
    return new FileSandbox(await realpath(root), testHooks);
  }

  getRoot(): string {
    return this.root;
  }

  async list(maxFiles = 2_000, ignoredPaths: readonly string[] = []): Promise<SharedFile[]> {
    const files: SharedFile[] = [];
    const ignored = normalizedIgnoredPaths(ignoredPaths);
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= maxFiles) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        const absolute = resolve(directory, entry.name);
        const relativePath = relative(this.root, absolute)
          .split(sep)
          .join("/");
        if (
          (entry.isDirectory() && SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) ||
          pathIsIgnored(relativePath, ignored)
        ) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (entry.isFile()) {
          const metadata = await stat(absolute);
          files.push({
            path: relativePath,
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
          });
        }
      }
    };
    await visit(this.root);
    return files;
  }

  async read(relativePath: string): Promise<ReadSharedFile> {
    const absolute = await this.resolveExisting(relativePath);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) {
      throw new Error("Requested path is not a file");
    }
    if (metadata.size > 2_000_000) {
      throw new Error("File exceeds the 2 MB collaboration read limit");
    }
    const bytes = await readFile(absolute);
    let content: string;
    try {
      // Keep an on-disk UTF-8 BOM as U+FEFF so content, byte size and SHA-256
      // all describe the same bytes across snapshots and direct reads.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new Error("The collaboration editor supports UTF-8 text files only");
    }
    if (content.includes("\0")) {
      throw new Error("The collaboration editor supports text files only");
    }
    return {
      path: relative(this.root, absolute).split(sep).join("/"),
      content,
      size: metadata.size,
      sha256: sha256(bytes),
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  async createDirectory(relativePath: string): Promise<string> {
    return createSafeWorkspaceDirectory(this.root, relativePath);
  }

  async rename(sourcePath: string, destinationPath: string, expectedSha256: string | null): Promise<ReadSharedFile | null> {
    const source = await this.resolveExisting(sourcePath);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error("Only regular workspace files and directories can be renamed");
    }
    const file = metadata.isFile() ? await this.read(sourcePath) : null;
    try {
      return await renameSandboxEntry({
        root: this.root,
        source,
        destinationPath,
        expectedSha256,
        sourceFile: file,
        platform: this.testHooks.platform ?? process.platform,
      });
    } catch (error) {
      if (error instanceof SandboxRenameConflictError) {
        throw new FileConflictError(error.message);
      }
      throw error;
    }
  }

  async write(
    relativePath: string,
    content: string,
    expectedSha256?: string,
  ): Promise<ReadSharedFile> {
    const platform = this.testHooks.platform ?? process.platform;
    if (platform !== "win32") {
      throw new Error(
        "Collaboration writes require Windows atomic file replacement support",
      );
    }
    if (Buffer.byteLength(content) > 2_000_000) {
      throw new Error("File exceeds the 2 MB collaboration write limit");
    }
    const absolute = resolve(this.root, relativePath);
    if (isAbsolute(relativePath) || !isInside(this.root, absolute)) {
      throw new Error("Path is outside the approved shared root");
    }

    return this.withPathWriteLock(absolute, async () => {
      await this.ensureWritableParent(absolute);

      let currentHash: string | undefined;
      try {
        const fileInfo = await lstat(absolute);
        if (fileInfo.isSymbolicLink()) {
          throw new Error("Writing through symbolic links is not supported");
        }
        if (!fileInfo.isFile()) throw new Error("Requested path is not a file");
        currentHash = sha256(await readFile(absolute));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      if (expectedSha256 !== undefined && expectedSha256 !== (currentHash ?? "")) {
        throw new FileConflictError(
          `File changed since it was read. Expected ${expectedSha256}, current ${
            currentHash ?? "<missing>"
          }.`,
        );
      }

      const journalRoot = resolve(this.root, ".codex-collab", "recovery");
      const candidateDirectory = resolve(journalRoot, "candidate");
      const recoveryDirectory = resolve(journalRoot, "recovery");
      const metadataDirectory = resolve(journalRoot, "metadata");
      const journalDirectories = [
        resolve(this.root, ".codex-collab"),
        journalRoot,
        candidateDirectory,
        recoveryDirectory,
        metadataDirectory,
      ];
      await this.ensureRecoveryJournal(journalDirectories);
      const transactionId = randomUUID();
      const candidate = resolve(candidateDirectory, transactionId);
      const recovery = resolve(recoveryDirectory, transactionId);
      const metadata = resolve(metadataDirectory, transactionId);
      const requestedHash = sha256(content);
      let preserveCandidate = false;
      try {
        await this.testHooks.beforeCandidateOpen?.(candidate);
        const candidateHandle = await open(candidate, "wx", 0o600);
        try {
          await candidateHandle.writeFile(content, "utf8");
          await candidateHandle.sync();
        } finally {
          await candidateHandle.close();
        }
        await this.testHooks.beforeFinalWriteCheck?.(absolute);
        await this.ensureRecoveryJournal(journalDirectories);
        const targetRelativePath = relative(this.root, absolute).split(sep).join("/");
        const result = await runWindowsFileCas({
          root: this.root,
          target: absolute,
          candidate,
          recovery,
          journal: metadata,
          transactionId,
          targetRelativePath,
          // Legacy callers that omit an expected hash still get a strict CAS
          // against the state observed at the start of this write.
          expectedSha256: expectedSha256 ?? currentHash ?? "",
          requestedSha256: requestedHash,
          ...(this.testHooks.windowsCasDebug
            ? { debug: this.testHooks.windowsCasDebug }
            : {}),
        });
        preserveCandidate = result.targetMoved && !result.candidateMoved;
        if (result.status === "conflict") {
          throw new FileConflictError(
            `${result.message} (phase: ${result.phase}; recovery transaction: ${transactionId})`,
          );
        }
        if (result.status !== "committed") {
          throw new Error(
            `${result.message} (phase: ${result.phase}; recovery transaction: ${transactionId})`,
          );
        }
        // Do not re-open the path after the guarded helper reports commit: an
        // unrelated writer could legitimately change it after the guard is
        // released. The helper hashed the exact candidate handle it published.
        return {
          path: targetRelativePath,
          content,
          size: Buffer.byteLength(content),
          sha256: requestedHash,
          modifiedAt: result.modifiedAt ?? new Date().toISOString(),
        };
      } finally {
        if (!preserveCandidate) {
          // A killed native helper cannot report TargetMoved back to Node. Once
          // its exclusively-created journal exists, the target may already be
          // in recovery (including the rename-to-journal-append crash gap), so
          // keep the candidate as recovery evidence instead of deleting the
          // member's requested content.
          try {
            await lstat(metadata);
            preserveCandidate = true;
          } catch (error) {
            // Delete only when the journal is conclusively absent. Permission
            // or transient inspection failures must retain the candidate.
            preserveCandidate =
              (error as NodeJS.ErrnoException).code !== "ENOENT";
          }
        }
        if (!preserveCandidate) {
          await unlink(candidate).catch(() => undefined);
        }
        await this.pruneRecoveryJournal(journalRoot);
      }
    });
  }

  private async ensureRecoveryJournal(directories: readonly string[]): Promise<void> {
    for (const directory of directories) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          "The internal collaboration recovery journal must be a real directory",
        );
      }
      const resolvedDirectory = await realpath(directory);
      if (!isInside(this.root, resolvedDirectory)) {
        throw new Error(
          "The internal collaboration recovery journal escapes the approved root",
        );
      }
    }
  }

  private async pruneRecoveryJournal(journalRoot: string): Promise<void> {
    const transactions = new Map<
      string,
      { paths: string[]; size: number; modifiedAt: number; committed: boolean }
    >();
    for (const name of ["candidate", "recovery", "metadata"]) {
      const directory = resolve(journalRoot, name);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = resolve(directory, entry.name);
        const metadata = await stat(path).catch(() => null);
        if (!metadata) continue;
        const transaction = transactions.get(entry.name) ?? {
          paths: [],
          size: 0,
          modifiedAt: 0,
          committed: false,
        };
        transaction.paths.push(path);
        transaction.size += metadata.size;
        transaction.modifiedAt = Math.max(transaction.modifiedAt, metadata.mtimeMs);
        if (name === "metadata") {
          const records = (await readFile(path, "utf8").catch(() => ""))
            .split(/\r?\n/)
            .filter(Boolean);
          try {
            const last = JSON.parse(records.at(-1) ?? "{}") as { phase?: string };
            transaction.committed =
              last.phase === "replacement-committed" ||
              last.phase === "new-file-committed";
          } catch {
            // A partial journal is recovery evidence and must never be pruned
            // as if the transaction had committed successfully.
          }
        }
        transactions.set(entry.name, transaction);
      }
    }
    const ordered = [...transactions.values()].sort(
      (left, right) => right.modifiedAt - left.modifiedAt,
    );
    let retainedCount = 0;
    let retainedBytes = 0;
    for (const transaction of ordered) {
      if (!transaction.committed) continue;
      retainedCount += 1;
      retainedBytes += transaction.size;
      if (
        retainedCount > RECOVERY_TRANSACTION_LIMIT ||
        retainedBytes > RECOVERY_BYTE_LIMIT
      ) {
        await Promise.all(
          transaction.paths.map((path) => unlink(path).catch(() => undefined)),
        );
      }
    }
  }

  private async withPathWriteLock<T>(
    absolute: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
    const previous = pathWriteLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    pathWriteLocks.set(lockKey, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (pathWriteLocks.get(lockKey) === tail) {
        pathWriteLocks.delete(lockKey);
      }
    }
  }

  private async ensureWritableParent(absolute: string): Promise<void> {
    const parent = dirname(absolute);
    let nearestExisting = parent;
    for (;;) {
      if (!isInside(this.root, nearestExisting)) {
        throw new Error("Path is outside the approved shared root");
      }
      try {
        const metadata = await lstat(nearestExisting);
        if (metadata.isSymbolicLink()) {
          const target = await realpath(nearestExisting);
          if (!isInside(this.root, target)) {
            throw new Error("Path escapes the approved root through a symbolic link");
          }
        } else if (!metadata.isDirectory()) {
          throw new Error("A parent path is not a directory");
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const next = dirname(nearestExisting);
        if (next === nearestExisting) {
          throw new Error("No writable parent exists inside the approved root");
        }
        nearestExisting = next;
      }
    }

    await mkdir(parent, { recursive: true });
    const parentRealPath = await realpath(parent);
    if (!isInside(this.root, parentRealPath)) {
      throw new Error("Path escapes the approved root through a symbolic link");
    }
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new Error("Use a path relative to the approved shared root");
    }
    const requested = resolve(this.root, relativePath);
    if (!isInside(this.root, requested)) {
      throw new Error("Path is outside the approved shared root");
    }
    const resolved = await realpath(requested);
    if (!isInside(this.root, resolved)) {
      throw new Error("Path escapes the approved root through a symbolic link");
    }
    return resolved;
  }
}

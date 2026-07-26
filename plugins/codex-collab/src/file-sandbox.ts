import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SharedFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ReadSharedFile {
  path: string;
  content: string;
  sha256: string;
  modifiedAt: string;
}

export class FileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileConflictError";
  }
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".codex-collab",
  ".git",
  ".next",
  ".runtime-data",
  "coverage",
  "dist",
  "node_modules",
]);

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
  return ignoredPaths.some((ignored) => path === ignored || path.startsWith(`${ignored}/`));
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class FileSandbox {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileSandbox> {
    if (!isAbsolute(root)) {
      throw new Error("Shared root must be an absolute path");
    }
    return new FileSandbox(await realpath(root));
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
          (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) ||
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
    const content = await readFile(absolute, "utf8");
    return {
      path: relative(this.root, absolute).split(sep).join("/"),
      content,
      sha256: sha256(content),
      modifiedAt: metadata.mtime.toISOString(),
    };
  }

  async write(
    relativePath: string,
    content: string,
    expectedSha256?: string,
  ): Promise<ReadSharedFile> {
    const absolute = resolve(this.root, relativePath);
    if (isAbsolute(relativePath) || !isInside(this.root, absolute)) {
      throw new Error("Path is outside the approved shared root");
    }

    await mkdir(dirname(absolute), { recursive: true });
    const parentRealPath = await realpath(dirname(absolute));
    if (!isInside(this.root, parentRealPath)) {
      throw new Error("Path escapes the approved root through a symbolic link");
    }

    let currentHash: string | undefined;
    try {
      const fileInfo = await lstat(absolute);
      if (fileInfo.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!isInside(this.root, target)) {
          throw new Error("Symbolic link points outside the approved shared root");
        }
      }
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

    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, absolute);
    return this.read(relativePath);
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

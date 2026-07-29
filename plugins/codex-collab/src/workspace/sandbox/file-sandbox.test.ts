import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileConflictError, FileSandbox } from "./file-sandbox.js";
import { runWindowsFileCas } from "./windows-file-cas.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-collab-files-"));
  roots.push(root);
  return root;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function runPowerShell(script: string, paths: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_CAS_TEST_PATHS: Buffer.from(JSON.stringify(paths), "utf8").toString(
            "base64",
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`PowerShell test helper failed (${code}): ${stderr}`));
    });
  });
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk: string) => (stderr += chunk));
    killer.once("error", reject);
    killer.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill failed (${code}): ${stderr}`));
    });
  });
}

function killProcess(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/F"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk: string) => (stderr += chunk));
    killer.once("error", reject);
    killer.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill failed (${code}): ${stderr}`));
    });
  });
}

const decodePowerShellPaths =
  "$p=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_CAS_TEST_PATHS))|ConvertFrom-Json);";

function readJournalRecords(content: string): Array<Record<string, string>> {
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileSandbox", () => {
  it("reads and writes only inside the approved root", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "first", "utf8");
    const sandbox = await FileSandbox.create(root);

    const original = await sandbox.read("notes.md");
    const updated = await sandbox.write("notes.md", "second", original.sha256);

    expect(updated.content).toBe("second");
    const journalRoot = join(root, ".codex-collab", "recovery");
    const recoveries = await readdir(join(journalRoot, "recovery"));
    const metadataFiles = await readdir(join(journalRoot, "metadata"));
    expect(recoveries).toHaveLength(1);
    expect(metadataFiles).toEqual(recoveries);
    expect(await readFile(join(journalRoot, "recovery", recoveries[0]!), "utf8")).toBe(
      "first",
    );
    const records = readJournalRecords(
      await readFile(join(journalRoot, "metadata", metadataFiles[0]!), "utf8"),
    );
    expect(records[0]).toMatchObject({ phase: "prepared" });
    expect(records.at(-1)).toMatchObject({
      target: "notes.md",
      expectedSha256: original.sha256,
      requestedSha256: updated.sha256,
      phase: "replacement-committed",
    });
    const targetIdentity = await stat(join(root, "notes.md"), { bigint: true });
    const recoveryIdentity = await stat(
      join(journalRoot, "recovery", recoveries[0]!),
      { bigint: true },
    );
    expect(targetIdentity.ino).not.toBe(recoveryIdentity.ino);
    await expect(sandbox.read("../outside.txt")).rejects.toThrow(/outside/i);
  });

  it("rejects stale optimistic hashes", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.txt");
    await writeFile(path, "version one", "utf8");
    const sandbox = await FileSandbox.create(root);
    const firstRead = await sandbox.read("shared.txt");

    await writeFile(path, "changed elsewhere", "utf8");
    await expect(sandbox.write("shared.txt", "my edit", firstRead.sha256)).rejects.toBeInstanceOf(
      FileConflictError,
    );
    expect(await readFile(path, "utf8")).toBe("changed elsewhere");
  });

  it("detects a pre-hash race before changing the target", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "version one", "utf8");
    const reader = await FileSandbox.create(root);
    const firstRead = await reader.read("shared.ts");
    const sandbox = await FileSandbox.create(root, {
      beforeFinalWriteCheck: async (absolutePath) => {
        await writeFile(absolutePath, "external edit", "utf8");
      },
    });

    await expect(
      sandbox.write("shared.ts", "collaboration edit", firstRead.sha256),
    ).rejects.toBeInstanceOf(FileConflictError);
    expect(await readFile(path, "utf8")).toBe("external edit");
    const recoveryRoot = join(root, ".codex-collab", "recovery");
    const recoveryFiles = await readdir(join(recoveryRoot, "recovery"));
    const candidateFiles = await readdir(join(recoveryRoot, "candidate"));
    expect(recoveryFiles).toEqual([]);
    expect(candidateFiles).toEqual([]);
  });

  it("refuses to start while another process has an existing write handle", async () => {
    const root = await tempRoot();
    const target = join(root, "guarded.ts");
    const signal = join(root, "holder-ready");
    const release = join(root, "holder-release");
    await writeFile(target, "A", "utf8");
    const sandbox = await FileSandbox.create(root);
    const original = await sandbox.read("guarded.ts");
    const holder = runPowerShell(
      `${decodePowerShellPaths}$stream=[IO.File]::Open($p.target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite);[IO.File]::WriteAllText($p.signal,'ready');while(-not(Test-Path -LiteralPath $p.release)){Start-Sleep -Milliseconds 10};$stream.Dispose()`,
      { target, signal, release },
    );
    await waitForPath(signal);

    await expect(
      sandbox.write("guarded.ts", "C", original.sha256),
    ).rejects.toBeInstanceOf(FileConflictError);
    expect(await readFile(target, "utf8")).toBe("A");
    await writeFile(release, "release", "utf8");
    await holder;
  });

  it("holds a native guard that blocks external write and File.Replace", async () => {
    const root = await tempRoot();
    const target = join(root, "guarded.ts");
    const replacement = join(root, "external-candidate.ts");
    const backup = join(root, "external-backup.ts");
    const signal = join(root, "cas-guarded");
    const release = join(root, "cas-continue");
    await writeFile(target, "A", "utf8");
    await writeFile(replacement, "B", "utf8");
    const original = await (await FileSandbox.create(root)).read("guarded.ts");
    const sandbox = await FileSandbox.create(root, {
      windowsCasDebug: { guardSignalPath: signal, guardContinuePath: release },
    });

    const write = sandbox.write("guarded.ts", "C", original.sha256);
    await waitForPath(signal);
    const blocked = await runPowerShell(
      `${decodePowerShellPaths}$writeBlocked=$false;$replaceBlocked=$false;try{[IO.File]::WriteAllText($p.target,'B')}catch{$writeBlocked=$true};try{[IO.File]::Replace($p.replacement,$p.target,$p.backup,$false)}catch{$replaceBlocked=$true};Write-Output ($writeBlocked.ToString()+','+$replaceBlocked.ToString())`,
      { target, replacement, backup },
    );
    expect(blocked).toBe("True,True");
    expect(await readFile(target, "utf8")).toBe("A");
    await writeFile(release, "continue", "utf8");
    await expect(write).resolves.toMatchObject({ content: "C" });
    expect(await readFile(target, "utf8")).toBe("C");
  }, 20_000);

  it("never rolls back over a file created in the publication window", async () => {
    const root = await tempRoot();
    const target = join(root, "window.ts");
    const signal = join(root, "target-moved");
    const release = join(root, "publish-continue");
    await writeFile(target, "A", "utf8");
    const original = await (await FileSandbox.create(root)).read("window.ts");
    const sandbox = await FileSandbox.create(root, {
      windowsCasDebug: {
        targetMovedSignalPath: signal,
        publishContinuePath: release,
      },
    });

    const write = sandbox.write("window.ts", "C", original.sha256);
    await waitForPath(signal);
    await runPowerShell(
      `${decodePowerShellPaths}[IO.File]::WriteAllText($p.target,'B')`,
      { target },
    );
    await writeFile(release, "continue", "utf8");
    await expect(write).rejects.toBeInstanceOf(FileConflictError);

    expect(await readFile(target, "utf8")).toBe("B");
    const journalRoot = join(root, ".codex-collab", "recovery");
    const recoveries = await readdir(join(journalRoot, "recovery"));
    const candidates = await readdir(join(journalRoot, "candidate"));
    const journals = await readdir(join(journalRoot, "metadata"));
    expect(recoveries).toHaveLength(1);
    expect(candidates).toEqual(recoveries);
    expect(journals).toEqual(recoveries);
    expect(await readFile(join(journalRoot, "recovery", recoveries[0]!), "utf8")).toBe(
      "A",
    );
    expect(await readFile(join(journalRoot, "candidate", candidates[0]!), "utf8")).toBe(
      "C",
    );
    expect(
      readJournalRecords(
        await readFile(join(journalRoot, "metadata", journals[0]!), "utf8"),
      ).map((record) => record.phase),
    ).toEqual(["prepared", "target-recovered", "publish-conflict"]);
  });

  it("leaves a fsynced recoverable transaction when the helper process tree is killed", async () => {
    const root = await tempRoot();
    const target = join(root, "killed.ts");
    const signal = join(root, "target-moved");
    const release = join(root, "never-released");
    await writeFile(target, "A", "utf8");
    const encodedPaths = Buffer.from(
      JSON.stringify({
        root,
        target,
        signal,
        release,
        moduleUrl: new URL("./file-sandbox.ts", import.meta.url).href,
      }),
      "utf8",
    ).toString("base64");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const p=JSON.parse(Buffer.from(process.env.CODEX_CAS_TEST_PATHS,'base64').toString('utf8'));const {FileSandbox}=await import(p.moduleUrl);const s=await FileSandbox.create(p.root,{windowsCasDebug:{targetMovedSignalPath:p.signal,publishContinuePath:p.release}});const f=await s.read('killed.ts');await s.write('killed.ts','C',f.sha256);`,
      ],
      {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        env: { ...process.env, CODEX_CAS_TEST_PATHS: encodedPaths },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (childStderr += chunk));
    const childExit = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });

    await waitForPath(signal);
    await killProcessTree(child.pid!);
    const exitCode = await childExit;
    expect(exitCode).not.toBe(0);

    const journalRoot = join(root, ".codex-collab", "recovery");
    const recoveries = await readdir(join(journalRoot, "recovery"));
    const candidates = await readdir(join(journalRoot, "candidate"));
    const journals = await readdir(join(journalRoot, "metadata"));
    expect(recoveries).toHaveLength(1);
    expect(candidates).toEqual(recoveries);
    expect(journals).toEqual(recoveries);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(journalRoot, "recovery", recoveries[0]!), "utf8")).toBe(
      "A",
    );
    expect(await readFile(join(journalRoot, "candidate", candidates[0]!), "utf8")).toBe(
      "C",
    );
    expect(
      readJournalRecords(
        await readFile(join(journalRoot, "metadata", journals[0]!), "utf8"),
      ).map((record) => record.phase),
    ).toEqual(["prepared", "target-recovered"]);
    await rename(join(journalRoot, "recovery", recoveries[0]!), target);
    expect(await readFile(target, "utf8")).toBe("A");
    expect(childStderr).not.toMatch(/uncaught/i);
  }, 20_000);

  it("preserves the candidate when only the native helper is killed", async () => {
    const root = await tempRoot();
    const target = join(root, "helper-killed.ts");
    const signal = join(root, "helper-target-moved");
    const release = join(root, "helper-never-released");
    await writeFile(target, "A", "utf8");
    const sandbox = await FileSandbox.create(root, {
      windowsCasDebug: {
        targetMovedSignalPath: signal,
        publishContinuePath: release,
      },
    });
    const original = await sandbox.read("helper-killed.ts");

    const write = sandbox.write("helper-killed.ts", "C", original.sha256);
    await waitForPath(signal);
    const helperPid = Number((await readFile(signal, "utf8")).trim());
    expect(Number.isSafeInteger(helperPid)).toBe(true);
    await killProcess(helperPid);
    await expect(write).rejects.toThrow(/helper failed/i);

    const journalRoot = join(root, ".codex-collab", "recovery");
    const recoveries = await readdir(join(journalRoot, "recovery"));
    const candidates = await readdir(join(journalRoot, "candidate"));
    const journals = await readdir(join(journalRoot, "metadata"));
    expect(recoveries).toHaveLength(1);
    expect(candidates).toEqual(recoveries);
    expect(journals).toEqual(recoveries);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(journalRoot, "recovery", recoveries[0]!), "utf8")).toBe(
      "A",
    );
    expect(await readFile(join(journalRoot, "candidate", candidates[0]!), "utf8")).toBe(
      "C",
    );
    expect(
      readJournalRecords(
        await readFile(join(journalRoot, "metadata", journals[0]!), "utf8"),
      ).map((record) => record.phase),
    ).toEqual(["prepared", "target-recovered"]);
  }, 20_000);

  it("allows at most one of two native writers with the same expected hash", async () => {
    const root = await tempRoot();
    const target = join(root, "contended.ts");
    await writeFile(target, "A", "utf8");
    const journalRoot = join(root, ".codex-collab", "recovery");
    for (const directory of ["candidate", "recovery", "metadata"]) {
      await mkdir(join(journalRoot, directory), { recursive: true });
    }
    const transactionIds = [randomUUID(), randomUUID()];
    const contents = ["C-one", "C-two"];
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        join(journalRoot, "candidate", transactionIds[index]!),
        contents[index]!,
        { encoding: "utf8", flag: "wx" },
      );
    }
    const results = await Promise.all(
      transactionIds.map((transactionId, index) =>
        runWindowsFileCas({
          root,
          target,
          candidate: join(journalRoot, "candidate", transactionId),
          recovery: join(journalRoot, "recovery", transactionId),
          journal: join(journalRoot, "metadata", transactionId),
          transactionId,
          targetRelativePath: "contended.ts",
          expectedSha256: contentHash("A"),
          requestedSha256: contentHash(contents[index]!),
        }),
      ),
    );
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    expect(contents).toContain(await readFile(target, "utf8"));
  });

  it("reports commit even when committed metadata cannot be appended", async () => {
    const root = await tempRoot();
    const target = join(root, "metadata-warning.ts");
    const transactionId = randomUUID();
    const journalRoot = join(root, ".codex-collab", "recovery");
    const candidate = join(journalRoot, "candidate", transactionId);
    const recovery = join(journalRoot, "recovery", transactionId);
    const journal = join(journalRoot, "metadata", transactionId);
    await writeFile(target, "A", "utf8");
    for (const directory of ["candidate", "recovery", "metadata"]) {
      await mkdir(join(journalRoot, directory), { recursive: true });
    }
    await writeFile(candidate, "C", { encoding: "utf8", flag: "wx" });

    const result = await runWindowsFileCas({
      root,
      target,
      candidate,
      recovery,
      journal,
      transactionId,
      targetRelativePath: "metadata-warning.ts",
      expectedSha256: contentHash("A"),
      requestedSha256: contentHash("C"),
      debug: { failMetadataAfterPublish: true },
    });

    expect(result).toMatchObject({
      status: "committed",
      phase: "replacement-committed",
      candidateMoved: true,
      metadataWarning: expect.any(String),
    });
    expect(await readFile(target, "utf8")).toBe("C");
    expect(await readFile(recovery, "utf8")).toBe("A");
    expect(readJournalRecords(await readFile(journal, "utf8")).map((r) => r.phase)).toEqual([
      "prepared",
      "target-recovered",
    ]);
  });

  it("publishes new files without clobbering a concurrently created target", async () => {
    const root = await tempRoot();
    const target = join(root, "new.ts");
    const sandbox = await FileSandbox.create(root, {
      beforeFinalWriteCheck: async () => {
        await writeFile(target, "external new file", "utf8");
      },
    });

    await expect(sandbox.write("new.ts", "collaboration file", "")).rejects.toBeInstanceOf(
      FileConflictError,
    );
    expect(await readFile(target, "utf8")).toBe("external new file");
  });

  it("uses exclusive random candidate creation and cannot follow a preoccupied symlink", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const victim = join(outside, "victim.ts");
    await writeFile(victim, "outside stays safe", "utf8");
    let candidateName = "";
    const sandbox = await FileSandbox.create(root, {
      beforeCandidateOpen: async (candidate) => {
        candidateName = candidate.split(/[\\/]/).at(-1) ?? "";
        await symlink(outside, candidate, "junction");
      },
    });

    await expect(sandbox.write("new.ts", "blocked", "")).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(candidateName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await readFile(victim, "utf8")).toBe("outside stays safe");
    await expect(readFile(join(root, "new.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails before mutation when the exclusive journal path is a symlink", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const target = join(root, "journal.ts");
    await writeFile(target, "A", "utf8");
    const original = await (await FileSandbox.create(root)).read("journal.ts");
    const sandbox = await FileSandbox.create(root, {
      beforeCandidateOpen: async (candidate) => {
        const transactionId = candidate.split(/[\\/]/).at(-1)!;
        await symlink(
          outside,
          join(root, ".codex-collab", "recovery", "metadata", transactionId),
          "junction",
        );
      },
    });

    await expect(
      sandbox.write("journal.ts", "C", original.sha256),
    ).rejects.toThrow(/journal/i);
    expect(await readFile(target, "utf8")).toBe("A");
    expect(await readdir(outside)).toEqual([]);
    expect(
      await readdir(join(root, ".codex-collab", "recovery", "recovery")),
    ).toEqual([]);
  });

  it("fails writes closed when Windows replacement support is unavailable", async () => {
    const root = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "original", "utf8");
    const sandbox = await FileSandbox.create(root, { platform: "linux" });

    await expect(sandbox.write("shared.ts", "blocked")).rejects.toThrow(
      /Windows atomic file replacement support/i,
    );
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("preserves a UTF-8 BOM for policy checks instead of silently stripping it", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x73, 0x65, 0x63]));
    const sandbox = await FileSandbox.create(root);

    await expect(sandbox.read("bom.txt")).resolves.toMatchObject({
      content: "\uFEFFsec",
    });
  });

  it("rejects a recovery journal symlink escape before creating candidates", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const path = join(root, "shared.ts");
    await writeFile(path, "original", "utf8");
    await mkdir(join(root, ".codex-collab"));
    await symlink(
      outside,
      join(root, ".codex-collab", "recovery"),
      "junction",
    );
    const sandbox = await FileSandbox.create(root);
    const original = await sandbox.read("shared.ts");

    await expect(
      sandbox.write("shared.ts", "blocked", original.sha256),
    ).rejects.toThrow(/recovery journal/i);
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a nested symlink escape before creating directories outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, "escape"), "junction");
    const sandbox = await FileSandbox.create(root);

    await expect(
      sandbox.write("escape/new/danger.txt", "blocked", ""),
    ).rejects.toThrow(/symbolic link/i);
    await expect(readFile(join(outside, "new", "danger.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not expose internal prompt attachment staging", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "visible.txt"), "visible", "utf8");
    await mkdir(join(root, ".codex-collab", "attachments-1"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".codex-collab", "attachments-1", "private.txt"),
      "private",
      "utf8",
    );
    const sandbox = await FileSandbox.create(root);

    await expect(sandbox.list()).resolves.toEqual([
      expect.objectContaining({ path: "visible.txt" }),
    ]);
  });

  it("skips host runtime data and caller-provided path prefixes", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".runtime-data"), { recursive: true });
    await mkdir(join(root, "public", "assets"), { recursive: true });
    await writeFile(join(root, ".runtime-data", "deploy.ps1"), "private", "utf8");
    await writeFile(join(root, "public", "assets", "index.js"), "generated", "utf8");
    await writeFile(join(root, "visible.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);

    await expect(sandbox.list(2_000, ["public/assets/"])).resolves.toEqual([
      expect.objectContaining({ path: "visible.ts" }),
    ]);
  });

  it("matches ignore entries with host filesystem case semantics", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "Private.ts"), "export {};", "utf8");
    const sandbox = await FileSandbox.create(root);

    const files = await sandbox.list(2_000, ["private.ts"]);
    if (process.platform === "win32") {
      expect(files).toEqual([]);
    } else {
      expect(files).toEqual([expect.objectContaining({ path: "Private.ts" })]);
    }
  });
});

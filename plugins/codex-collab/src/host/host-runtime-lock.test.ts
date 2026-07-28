import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostRuntimeLock,
  releaseHostRuntimeLock,
} from "./host-runtime-lock.js";

const temporaryDirectories: string[] = [];

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-collab-host-lock-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Host runtime lock", () => {
  it("creates and releases a lock owned by the current runtime", async () => {
    const lockPath = await temporaryLockPath();

    await expect(acquireHostRuntimeLock(lockPath, 101, () => false)).resolves.toBe(true);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 101 });

    await releaseHostRuntimeLock(lockPath, 101);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replace a lock held by a running runtime", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, JSON.stringify({ pid: 202 }), "utf8");

    await expect(acquireHostRuntimeLock(lockPath, 303, (pid) => pid === 202)).resolves.toBe(
      false,
    );
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 202 });
  });

  it("replaces a stale or malformed lock without deleting another owner's lock", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, "not-json", "utf8");

    await expect(acquireHostRuntimeLock(lockPath, 404, () => false)).resolves.toBe(true);
    await releaseHostRuntimeLock(lockPath, 999);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 404 });
  });
});

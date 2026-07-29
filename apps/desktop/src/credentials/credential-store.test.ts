import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Member, Session } from "@codex-collab/protocol";
import {
  CorruptCredentialError,
  CredentialEncryptionUnavailableError,
  EncryptedCredentialStore,
  type CredentialEncryption,
} from "./credential-store.js";

const temporaryDirectories: string[] = [];

function session(): Session {
  return {
    id: "session-one",
    name: "Room",
    ownerMemberId: "member-owner",
    roomStatus: "open",
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

function member(): Member {
  return {
    id: "member-owner",
    sessionId: "session-one",
    displayName: "Owner",
    deviceLabel: "Desktop",
    role: "owner",
    status: "approved",
    workspaceFileAccess: "workspace-write",
    createdAt: "2026-07-28T00:00:00.000Z",
    approvedAt: "2026-07-28T00:00:00.000Z",
  };
}

const encryption: CredentialEncryption = {
  isAvailable: () => true,
  encrypt: (plainText) =>
    Buffer.from(`encrypted:${Buffer.from(plainText).toString("base64")}`, "utf8"),
  decrypt: (cipherText) => {
    const value = cipherText.toString("utf8");
    if (!value.startsWith("encrypted:")) throw new Error("bad ciphertext");
    return Buffer.from(value.slice("encrypted:".length), "base64").toString("utf8");
  },
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-collab-desktop-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("encrypted credential store", () => {
  it("persists the token only through the encryption provider", async () => {
    const store = new EncryptedCredentialStore(await temporaryDirectory(), encryption);
    await store.save({ session: session(), member: member(), token: "test-owner-token" });

    const raw = await readFile(store.filePath, "utf8");
    expect(raw.startsWith("encrypted:")).toBe(true);
    expect(raw).not.toContain("test-owner-token");
    await expect(store.load()).resolves.toMatchObject({ token: "test-owner-token" });
  });

  it("fails closed when Windows encryption is unavailable", async () => {
    const store = new EncryptedCredentialStore(await temporaryDirectory(), {
      ...encryption,
      isAvailable: () => false,
    });
    await expect(store.load()).rejects.toBeInstanceOf(
      CredentialEncryptionUnavailableError,
    );
  });

  it("quarantines damaged ciphertext instead of overwriting it", async () => {
    const directory = await temporaryDirectory();
    const store = new EncryptedCredentialStore(directory, encryption);
    await writeFile(store.filePath, "not-encrypted", "utf8");

    await expect(store.load()).rejects.toBeInstanceOf(CorruptCredentialError);
    expect((await readdir(directory)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });
});

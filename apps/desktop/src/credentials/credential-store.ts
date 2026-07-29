import type { Member, Session } from "@codex-collab/protocol";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DesktopCredential {
  session: Session;
  member: Member;
  token: string;
}

export interface CredentialEncryption {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export class CredentialEncryptionUnavailableError extends Error {
  constructor() {
    super("Windows credential encryption is unavailable.");
    this.name = "CredentialEncryptionUnavailableError";
  }
}

export class CorruptCredentialError extends Error {
  constructor(readonly quarantinePath: string) {
    super("The saved owner session is damaged and was quarantined.");
    this.name = "CorruptCredentialError";
  }
}

function assertCredential(value: unknown): DesktopCredential {
  if (!value || typeof value !== "object") throw new Error("invalid_credential");
  const candidate = value as Partial<DesktopCredential>;
  if (
    !candidate.session ||
    typeof candidate.session.id !== "string" ||
    !candidate.member ||
    typeof candidate.member.id !== "string" ||
    typeof candidate.token !== "string" ||
    candidate.token.length < 1 ||
    candidate.token.length > 1_000 ||
    candidate.member.sessionId !== candidate.session.id
  ) {
    throw new Error("invalid_credential");
  }
  return candidate as DesktopCredential;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class EncryptedCredentialStore {
  readonly filePath: string;
  private currentWrite: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly encryption: CredentialEncryption,
  ) {
    this.filePath = join(userDataPath, "owner-session.bin");
  }

  private ensureEncryption(): void {
    if (!this.encryption.isAvailable()) {
      throw new CredentialEncryptionUnavailableError();
    }
  }

  async load(): Promise<DesktopCredential | null> {
    this.ensureEncryption();
    if (!(await exists(this.filePath))) return null;
    try {
      const encrypted = await readFile(this.filePath);
      const decrypted = this.encryption.decrypt(encrypted);
      return assertCredential(JSON.parse(decrypted) as unknown);
    } catch (caught) {
      if (caught instanceof CredentialEncryptionUnavailableError) throw caught;
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await rename(this.filePath, quarantinePath);
      } catch {
        // Keep the original file intact if quarantine itself is unavailable.
      }
      throw new CorruptCredentialError(quarantinePath);
    }
  }

  async save(credential: DesktopCredential): Promise<void> {
    this.ensureEncryption();
    const validated = assertCredential(credential);
    const encrypted = this.encryption.encrypt(JSON.stringify(validated));
    if (encrypted.length > 64 * 1024) throw new Error("credential_too_large");

    this.currentWrite = this.currentWrite.catch(() => undefined).then(async () => {
      const parent = dirname(this.filePath);
      await mkdir(parent, { recursive: true });
      const temporaryPath = join(
        parent,
        `.${basename(this.filePath)}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(encrypted);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, this.filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
    await this.currentWrite;
  }

  async clear(): Promise<void> {
    await this.currentWrite;
    await rm(this.filePath, { force: true });
  }

  async flush(): Promise<void> {
    await this.currentWrite;
  }
}

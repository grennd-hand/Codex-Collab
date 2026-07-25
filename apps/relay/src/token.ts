import { createHash, randomBytes } from "node:crypto";

export function issueToken(
  prefix: "ccm" | "cci" | "ccp" | "cch" | "cca" | "ccs",
): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

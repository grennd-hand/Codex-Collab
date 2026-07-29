import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findObviousCredential,
  sensitivePackagedPath,
} from "./verify-desktop-artifact.mjs";

test("rejects packaged runtime data without rejecting application modules", () => {
  for (const path of [
    ".env",
    "config/.env.production",
    "data/relay.sqlite",
    "session/auth.json",
    "session/profile.json",
    "state/owner-session.bin",
    "guest-config.json",
  ]) {
    assert.equal(sensitivePackagedPath(path), true, path);
  }
  for (const path of [
    "dist/main/credential-store.js",
    "dist/main/desktop-config.js",
    "dist/renderer/assets/index.js",
    "node_modules/typescript/lib/lib.es2024.string.d.ts",
  ]) {
    assert.equal(sensitivePackagedPath(path), false, path);
  }
});

test("detects credential literals but permits names and placeholders", () => {
  assert.equal(
    findObviousCredential(
      "dist/main/config.js",
      'const ownerToken = "a-real-looking-secret-token-value-12345";',
    ),
    "credential assignment literal",
  );
  assert.equal(
    findObviousCredential("dist/main/config.js", 'const token = snapshot.ownerToken;'),
    null,
  );
  assert.equal(
    findObviousCredential("dist/main/config.js", 'const apiKey = "example-placeholder-value";'),
    null,
  );
  assert.equal(
    findObviousCredential("node_modules/dependency/index.js", "-----BEGIN PRIVATE KEY-----"),
    "private key material",
  );
});

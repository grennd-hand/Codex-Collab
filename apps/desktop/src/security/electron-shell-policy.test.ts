import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Electron shell hardening", () => {
  it("keeps the renderer sandboxed and blocks in-window navigation", async () => {
    const main = await readFile(join(sourceRoot, "main.ts"), "utf8");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("webSecurity: true");
    expect(main).toContain("allowRunningInsecureContent: false");
    expect(main).toContain("webviewTag: false");
    expect(main).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(main).toContain('on("will-navigate", (event) => event.preventDefault())');
  });

  it("uses one application instance and hides ordinary window closes", async () => {
    const main = await readFile(join(sourceRoot, "main.ts"), "utf8");
    expect(main).toContain("requestSingleInstanceLock()");
    expect(main).toContain('app.on("second-instance", showMainWindow)');
    expect(main).toContain("event.preventDefault();\n      window.hide();");
    expect(main).toContain("退出并停止 Host");
  });

  it("exposes only the enumerated preload bridge", async () => {
    const preload = await readFile(join(sourceRoot, "preload.cts"), "utf8");
    expect(preload).toContain('exposeInMainWorld("codexCollabDesktop", api)');
    expect(preload).not.toContain("window.require");
    expect(preload).not.toContain("sendSync");
    expect(preload).not.toContain("memberToken");
    expect(preload).not.toContain("authorization");
    expect(preload).not.toContain("headers");
    expect(preload).not.toContain("fetch(");
    expect(preload).not.toContain("new WebSocket");
    expect(preload).not.toContain("callTool");
    expect(preload).not.toContain("genericRequest");
    expect(preload).toContain('shellOpenExternal: "codex-collab:shell-open-external"');
  });
});

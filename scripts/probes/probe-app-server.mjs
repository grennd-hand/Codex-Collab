import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../../plugins/codex-collab/dist/app-server/app-server-client.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const client = new CodexAppServerClient();
let diagnostics = "";
client.on("diagnostic", (message) => {
  diagnostics += `${message}\n`;
});

try {
  const threads = await client.listThreads(repositoryRoot);
  process.stdout.write(
    `${JSON.stringify(
      {
        initialized: true,
        cwdFilter: repositoryRoot,
        threadCount: threads.length,
        threadIds: threads.slice(0, 3).map((thread) => thread.id),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${diagnostics}`);
  process.exitCode = 1;
} finally {
  await client.close();
}

import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this E2E through `npm run test:e2e`.");

function run(command, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`}).`,
        ),
      );
    });
  });
}

console.log(
  "Local process-level Beta E2E: temporary loopback Relay/SQLite plus Desktop focused tests.",
);
console.log(
  "This command never targets Guest. Packaged Electron UI, two real browser contexts and Windows VM installation remain manual release checks.",
);

const builds = [
  "@codex-collab/protocol",
  "@codex-collab/relay",
  "codex-collab",
];
for (const workspace of builds) {
  await run(process.execPath, [npmCli, "run", "build", "--workspace", workspace]);
}
await run(process.execPath, [
  npmCli,
  "run",
  "test",
  "--workspace",
  "@codex-collab/desktop",
]);
await run(process.execPath, ["scripts/probe-workspace-flow.mjs"]);

console.log(
  JSON.stringify({
    ok: true,
    scope: "process-level-local-e2e",
    network: "loopback-only",
    guestTouched: false,
    manualReleaseChecksPending: [
      "packaged Electron UI",
      "two browser contexts",
      "clean Windows 11 x64 VM install and upgrade",
    ],
  }),
);

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const foundationStyles = readFileSync(
  new URL("./foundation.css", import.meta.url),
  "utf8",
);

describe("workspace foundation layout", () => {
  it("keeps a direct single panel constrained to the workspace height", () => {
    expect(foundationStyles).toMatch(
      /\.workspace > \[data-workspace-panel\][\s\S]*?height:\s*100%/,
    );
  });
});

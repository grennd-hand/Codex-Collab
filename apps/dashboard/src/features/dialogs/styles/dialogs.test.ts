import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogStyles = readFileSync(new URL("./dialogs.css", import.meta.url), "utf8");

describe("workspace dialog layout", () => {
  it("wraps Fluent message content instead of creating horizontal overflow", () => {
    expect(dialogStyles).toMatch(
      /\.workspace-dialog-content \.fui-MessageBarBody[\s\S]*?white-space:\s*normal/,
    );
    expect(dialogStyles).toMatch(/overflow-x:\s*hidden/);
    expect(dialogStyles).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the pairing action inside the responsive heading", () => {
    expect(dialogStyles).toMatch(/\.workspace-section-heading[\s\S]*?flex-wrap:\s*wrap/);
    expect(dialogStyles).toMatch(
      /\.workspace-section-heading > \.fui-Button[\s\S]*?margin-left:\s*auto/,
    );
  });
});

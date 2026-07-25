import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_OPTIONS,
  ProtocolError,
} from "@codex-collab/protocol";
import {
  parseCodexOptions,
  validateCodexPromptCapabilities,
} from "./codex-options.js";

describe("parseCodexOptions", () => {
  it("accepts every canonical dashboard model id", () => {
    for (const option of CODEX_MODEL_OPTIONS) {
      expect(parseCodexOptions({ model: option.id }).model).toBe(option.id);
    }
  });

  it("normalizes legacy display labels for saved clients", () => {
    for (const option of CODEX_MODEL_OPTIONS) {
      expect(parseCodexOptions({ model: option.label }).model).toBe(option.id);
    }
  });

  it("rejects unknown model values", () => {
    expect(() => parseCodexOptions({ model: "not-a-real-model" })).toThrow(
      ProtocolError,
    );
  });

  it("accepts and preserves each custom permission dimension", () => {
    for (const fileAccess of [
      "read-only",
      "workspace-write",
      "full-access",
    ] as const) {
      for (const approvalPolicy of ["on-request", "never"] as const) {
        expect(
          parseCodexOptions({
            accessMode: "custom",
            customPermissions: { fileAccess, approvalPolicy },
          }).customPermissions,
        ).toEqual({ fileAccess, approvalPolicy });
      }
    }
  });

  it("rejects incomplete custom permissions and unknown access modes", () => {
    expect(() => parseCodexOptions({ accessMode: "custom" })).toThrow(
      ProtocolError,
    );
    expect(() =>
      parseCodexOptions({
        accessMode: "custom",
        customPermissions: { fileAccess: "somewhere", approvalPolicy: "never" },
      }),
    ).toThrow(ProtocolError);
    expect(() => parseCodexOptions({ accessMode: "root" })).toThrow(
      ProtocolError,
    );
    expect(() => parseCodexOptions({ reasoningEffort: "extreme" })).toThrow(
      ProtocolError,
    );
    expect(() => parseCodexOptions({ speed: "turbo" })).toThrow(ProtocolError);
  });

  it("drops hidden custom fields outside custom mode", () => {
    expect(
      parseCodexOptions({
        accessMode: "follow-desktop",
        customPermissions: {
          fileAccess: "full-access",
          approvalPolicy: "never",
        },
      }).customPermissions,
    ).toBeNull();
  });

  it("enforces model reasoning and speed capabilities", () => {
    expect(
      parseCodexOptions({ model: "gpt-5.6-sol", reasoningEffort: "ultra" })
        .reasoningEffort,
    ).toBe("ultra");
    expect(
      parseCodexOptions({ model: "gpt-5.6-luna", reasoningEffort: "max" })
        .reasoningEffort,
    ).toBe("max");
    expect(() =>
      parseCodexOptions({ model: "gpt-5.6-luna", reasoningEffort: "ultra" }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseCodexOptions({ model: "gpt-5.4-mini", speed: "fast" }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseCodexOptions({ model: "gpt-5.3-codex-spark", speed: "fast" }),
    ).toThrow(ProtocolError);
  });

  it("allows text attachments but rejects images for the text-only model", () => {
    const options = parseCodexOptions({ model: "gpt-5.3-codex-spark" });
    expect(() =>
      validateCodexPromptCapabilities(options, [{ mediaType: "text/plain" }]),
    ).not.toThrow();
    expect(() =>
      validateCodexPromptCapabilities(options, [{ mediaType: "image/png" }]),
    ).toThrow(ProtocolError);
  });
});

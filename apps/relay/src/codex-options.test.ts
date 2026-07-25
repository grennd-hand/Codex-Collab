import { describe, expect, it } from "vitest";
import {
  CODEX_MODEL_OPTIONS,
  ProtocolError,
} from "@codex-collab/protocol";
import { parseCodexOptions } from "./codex-options.js";

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
});

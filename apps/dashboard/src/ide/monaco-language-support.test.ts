import { describe, expect, it, vi } from "vitest";

const { definition } = vi.hoisted(() => ({
  definition: () => ({ conf: {}, language: { tokenizer: { root: [] } } }),
}));

vi.mock("monaco-editor/esm/vs/languages/definitions/css/css.js", definition);
vi.mock(
  "monaco-editor/esm/vs/languages/definitions/dockerfile/dockerfile.js",
  definition,
);
vi.mock("monaco-editor/esm/vs/languages/definitions/html/html.js", definition);
vi.mock("monaco-editor/esm/vs/languages/definitions/ini/ini.js", definition);
vi.mock(
  "monaco-editor/esm/vs/languages/definitions/javascript/javascript.js",
  definition,
);
vi.mock(
  "monaco-editor/esm/vs/languages/definitions/markdown/markdown.js",
  definition,
);
vi.mock(
  "monaco-editor/esm/vs/languages/definitions/powershell/powershell.js",
  definition,
);
vi.mock("monaco-editor/esm/vs/languages/definitions/scss/scss.js", definition);
vi.mock("monaco-editor/esm/vs/languages/definitions/shell/shell.js", definition);
vi.mock("monaco-editor/esm/vs/languages/definitions/sql/sql.js", definition);
vi.mock(
  "monaco-editor/esm/vs/languages/definitions/typescript/typescript.js",
  definition,
);
vi.mock("monaco-editor/esm/vs/languages/definitions/xml/xml.js", definition);
vi.mock("monaco-editor/esm/vs/languages/definitions/yaml/yaml.js", definition);

import { registerProjectLanguageSupport } from "./monaco-language-support.js";

describe("registerProjectLanguageSupport", () => {
  it("registers project tokenizers once before Monaco creates a model", () => {
    const setLanguageConfiguration = vi.fn();
    const setMonarchTokensProvider = vi.fn();
    const monaco = {
      languages: { setLanguageConfiguration, setMonarchTokensProvider },
    };

    registerProjectLanguageSupport(monaco as never);
    registerProjectLanguageSupport(monaco as never);

    expect(setLanguageConfiguration.mock.calls.map(([id]) => id)).toEqual([
      "css",
      "dockerfile",
      "html",
      "ini",
      "javascript",
      "markdown",
      "powershell",
      "scss",
      "shell",
      "sql",
      "typescript",
      "xml",
      "yaml",
    ]);
    expect(setMonarchTokensProvider.mock.calls.map(([id]) => id)).toEqual([
      "css",
      "dockerfile",
      "html",
      "ini",
      "javascript",
      "markdown",
      "powershell",
      "scss",
      "shell",
      "sql",
      "typescript",
      "xml",
      "yaml",
      "json",
    ]);
  });
});

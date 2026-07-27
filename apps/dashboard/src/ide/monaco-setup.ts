import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker.js?url";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?url";
import htmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker.js?url";
import jsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker.js?url";
import typeScriptWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker.js?url";
import { registerProjectLanguageSupport } from "./monaco-language-support.js";

type MonacoWorkerEnvironment = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};

(globalThis as MonacoWorkerEnvironment).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new Worker(jsonWorkerUrl, { type: "module" });
    if (label === "css" || label === "scss" || label === "less") {
      return new Worker(cssWorkerUrl, { type: "module" });
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new Worker(htmlWorkerUrl, { type: "module" });
    }
    if (label === "typescript" || label === "javascript") {
      return new Worker(typeScriptWorkerUrl, { type: "module" });
    }
    return new Worker(editorWorkerUrl, { type: "module" });
  },
};

loader.config({ monaco });
registerProjectLanguageSupport(monaco);

monaco.editor.defineTheme("codex-collab-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5A6B55", fontStyle: "italic" },
    { token: "keyword", foreground: "3158A6" },
    { token: "string", foreground: "A33A2B" },
    { token: "number", foreground: "0F6B60" },
    { token: "type.identifier", foreground: "76518A" },
    { token: "tag", foreground: "3158A6" },
    { token: "attribute.name", foreground: "76518A" },
  ],
  colors: {
    "editor.lineHighlightBackground": "F4F7FB",
    "editorIndentGuide.background1": "DDE3EA",
    "editorIndentGuide.activeBackground1": "8AA4C6",
  },
});

monaco.editor.defineTheme("codex-collab-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8EA58A", fontStyle: "italic" },
    { token: "keyword", foreground: "82AAFF" },
    { token: "string", foreground: "ECC48D" },
    { token: "number", foreground: "7FDBCA" },
    { token: "type.identifier", foreground: "C792EA" },
    { token: "tag", foreground: "82AAFF" },
    { token: "attribute.name", foreground: "C792EA" },
  ],
  colors: {
    "editor.lineHighlightBackground": "202938",
    "editorIndentGuide.background1": "2D3748",
    "editorIndentGuide.activeBackground1": "58739B",
  },
});

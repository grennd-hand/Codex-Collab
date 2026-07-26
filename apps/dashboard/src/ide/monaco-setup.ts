import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker.js?url";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?url";
import htmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker.js?url";
import jsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker.js?url";
import typeScriptWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker.js?url";

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

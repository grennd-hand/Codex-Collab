declare module "monaco-editor/esm/vs/languages/definitions/*" {
  import type * as monaco from "monaco-editor";

  export const conf: monaco.languages.LanguageConfiguration;
  export const language: monaco.languages.IMonarchLanguage;
}

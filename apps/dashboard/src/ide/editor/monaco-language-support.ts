import type * as Monaco from "monaco-editor";
import {
  conf as cssConfiguration,
  language as cssLanguage,
} from "monaco-editor/esm/vs/languages/definitions/css/css.js";
import {
  conf as dockerConfiguration,
  language as dockerLanguage,
} from "monaco-editor/esm/vs/languages/definitions/dockerfile/dockerfile.js";
import {
  conf as htmlConfiguration,
  language as htmlLanguage,
} from "monaco-editor/esm/vs/languages/definitions/html/html.js";
import {
  conf as iniConfiguration,
  language as iniLanguage,
} from "monaco-editor/esm/vs/languages/definitions/ini/ini.js";
import {
  conf as javascriptConfiguration,
  language as javascriptLanguage,
} from "monaco-editor/esm/vs/languages/definitions/javascript/javascript.js";
import {
  conf as markdownConfiguration,
  language as markdownLanguage,
} from "monaco-editor/esm/vs/languages/definitions/markdown/markdown.js";
import {
  conf as powershellConfiguration,
  language as powershellLanguage,
} from "monaco-editor/esm/vs/languages/definitions/powershell/powershell.js";
import {
  conf as scssConfiguration,
  language as scssLanguage,
} from "monaco-editor/esm/vs/languages/definitions/scss/scss.js";
import {
  conf as shellConfiguration,
  language as shellLanguage,
} from "monaco-editor/esm/vs/languages/definitions/shell/shell.js";
import {
  conf as sqlConfiguration,
  language as sqlLanguage,
} from "monaco-editor/esm/vs/languages/definitions/sql/sql.js";
import {
  conf as typescriptConfiguration,
  language as typescriptLanguage,
} from "monaco-editor/esm/vs/languages/definitions/typescript/typescript.js";
import {
  conf as xmlConfiguration,
  language as xmlLanguage,
} from "monaco-editor/esm/vs/languages/definitions/xml/xml.js";
import {
  conf as yamlConfiguration,
  language as yamlLanguage,
} from "monaco-editor/esm/vs/languages/definitions/yaml/yaml.js";

interface LanguageDefinition {
  id: string;
  configuration: Monaco.languages.LanguageConfiguration;
  language: Monaco.languages.IMonarchLanguage;
}

const projectLanguageDefinitions: readonly LanguageDefinition[] = [
  { id: "css", configuration: cssConfiguration, language: cssLanguage },
  { id: "dockerfile", configuration: dockerConfiguration, language: dockerLanguage },
  { id: "html", configuration: htmlConfiguration, language: htmlLanguage },
  { id: "ini", configuration: iniConfiguration, language: iniLanguage },
  {
    id: "javascript",
    configuration: javascriptConfiguration,
    language: javascriptLanguage,
  },
  {
    id: "markdown",
    configuration: markdownConfiguration,
    language: markdownLanguage,
  },
  {
    id: "powershell",
    configuration: powershellConfiguration,
    language: powershellLanguage,
  },
  { id: "scss", configuration: scssConfiguration, language: scssLanguage },
  { id: "shell", configuration: shellConfiguration, language: shellLanguage },
  { id: "sql", configuration: sqlConfiguration, language: sqlLanguage },
  {
    id: "typescript",
    configuration: typescriptConfiguration,
    language: typescriptLanguage,
  },
  { id: "xml", configuration: xmlConfiguration, language: xmlLanguage },
  { id: "yaml", configuration: yamlConfiguration, language: yamlLanguage },
];

const jsonLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".json",
  brackets: [
    { open: "{", close: "}", token: "delimiter.bracket" },
    { open: "[", close: "]", token: "delimiter.array" },
  ],
  tokenizer: {
    root: [
      [/\{/, { token: "delimiter.bracket", bracket: "@open" }],
      [/\}/, { token: "delimiter.bracket", bracket: "@close" }],
      [/\[/, { token: "delimiter.array", bracket: "@open" }],
      [/\]/, { token: "delimiter.array", bracket: "@close" }],
      [/"(?:\\.|[^"\\])*"(?=\s*:)/, "string.key"],
      [/"(?:\\.|[^"\\])*"/, "string.value"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/[,:]/, "delimiter"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
  },
};

let registered = false;

export function registerProjectLanguageSupport(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  for (const definition of projectLanguageDefinitions) {
    monaco.languages.setLanguageConfiguration(
      definition.id,
      definition.configuration,
    );
    monaco.languages.setMonarchTokensProvider(definition.id, definition.language);
  }
  monaco.languages.setMonarchTokensProvider("json", jsonLanguage);
}

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const dashboardRoot = fileURLToPath(new URL("../dashboard", import.meta.url));
const desktopRendererOutput = fileURLToPath(
  new URL("./dist/renderer", import.meta.url),
);

export default defineConfig({
  root: dashboardRoot,
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "monaco-editor": fileURLToPath(
        new URL("../../node_modules/monaco-editor", import.meta.url),
      ),
    },
  },
  build: {
    outDir: desktopRendererOutput,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@fluentui")) return "fluent";
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});

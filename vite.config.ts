// Shim for tooling that expects a plain Vite project at the repo root — notably
// the shadcn/ui CLI, whose framework detection looks for `vite.config.*` here.
// The real build config is electron.vite.config.ts; electron-vite does not read
// this file. Keep the plugins and aliases below in sync with the `renderer`
// section of electron.vite.config.ts.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./src/renderer",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@renderer": resolve("./src/renderer/src"),
      "@": resolve("./src/renderer/src"),
    },
  },
});

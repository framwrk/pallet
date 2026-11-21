import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import tailwindcss from "@tailwindcss/vite";

const shared = { "@shared": resolve("src/shared") };

export default defineConfig({
  main: { resolve: { alias: shared }, build: { externalizeDeps: { exclude: ["smb3-client"] } } },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@": resolve("src/renderer/src"),
        ...shared,
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});

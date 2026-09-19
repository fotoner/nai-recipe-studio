import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    resolve: { alias: { "@": resolve(".") } },
    build: {
      externalizeDeps: false,
      outDir: "dist/main",
      lib: { entry: "desktop/main/index.ts", formats: ["cjs"] },
      rollupOptions: { external: ["better-sqlite3"], output: { entryFileNames: "index.js" } },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: "dist/preload",
      lib: { entry: "desktop/preload/index.ts", formats: ["cjs"] },
      rollupOptions: { output: { entryFileNames: "index.js", inlineDynamicImports: true } },
    },
  },
  renderer: {
    root: "desktop/renderer",
    resolve: { alias: { "@": resolve(".") } },
    plugins: [react(), tailwindcss()],
    build: { outDir: resolve("dist/renderer"), rollupOptions: { input: resolve("desktop/renderer/index.html") } },
  },
});

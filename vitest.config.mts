import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node", setupFiles: ["./tests/setup.ts"] } },
      { extends: true, test: { name: "ui", include: ["tests/**/*.test.tsx"], environment: "jsdom", setupFiles: ["./tests/setup.ts", "./tests/setup-dom.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["core/**/*.ts", "lib/**/*.ts", "contracts/**/*.ts", "services/**/*.ts", "adapters/**/*.ts", "features/**/*.tsx", "desktop/main/**/*.ts", "desktop/mcp/**/*.ts"],
      reporter: ["text-summary", "html", "json-summary"],
    },
  },
});

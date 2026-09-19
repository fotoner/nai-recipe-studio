import { build } from "esbuild";

await build({
  entryPoints: ["desktop/mcp/index.ts"],
  outfile: "dist/mcp/index.cjs",
  platform: "node",
  target: "node24",
  format: "cjs",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
});

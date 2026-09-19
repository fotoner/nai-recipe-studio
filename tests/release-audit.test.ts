import { describe, expect, it } from "vitest";
import { inspectDistributionPath } from "../scripts/release-audit";

describe("release artifact allowlist", () => {
  it("rejects local credentials, generated data, sources and debug maps", () => {
    for (const name of [".env", "renderer/.env.local", "main/studio.db", "renderer/output/result.png", "recipes/personal.json", "main/index.js.map", "renderer/source.ts", "../main/index.js", "main/../../.env", "C:\\user\\secrets.json"]) {
      expect(inspectDistributionPath(name), name).not.toBeNull();
    }
  });

  it("accepts only the compiled entrypoints and hashed renderer assets", () => {
    for (const name of ["main/index.js", "preload/index.js", "mcp/index.cjs", "renderer/index.html", "renderer/assets/index-A1b2C3d4.js", "renderer/assets/index-ABCD1234.css"]) {
      expect(inspectDistributionPath(name), name).toBeNull();
    }
  });
});

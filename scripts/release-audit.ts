import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entries = new Set(["main/index.js", "preload/index.js", "mcp/index.cjs", "renderer/index.html"]);

export function inspectDistributionPath(relativePath: string): string | null {
  if (relativePath.includes("\\") || relativePath.split("/").some(part => part === ".." || part.startsWith("."))) return "UNSAFE_PATH";
  if (entries.has(relativePath)) return null;
  if (/^renderer\/assets\/[\w.-]+-[\w-]{8,}\.(js|css|woff2?)$/.test(relativePath)) return null;
  return "UNEXPECTED_ARTIFACT";
}

export async function auditDistribution(root: string) {
  const violations: string[] = [];
  const found = new Set<string>();
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { violations.push(`SYMLINK: ${relative}`); continue; }
      if (entry.isDirectory()) { await visit(absolute); continue; }
      const issue = inspectDistributionPath(relative);
      if (issue) { violations.push(`${issue}: ${relative}`); continue; }
      found.add(relative);
      if (/\.(js|cjs|html|css)$/.test(relative)) {
        const content = await readFile(absolute, "utf8");
        if (/(?:\/Users\/[^/\s]+\/|[A-Z]:\\Users\\)/.test(content)) violations.push(`LOCAL_HOME_PATH: ${relative}`);
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) violations.push(`PRIVATE_KEY: ${relative}`);
      }
    }
  }
  await visit(root);
  for (const entry of entries) if (!found.has(entry)) violations.push(`MISSING_ENTRY: ${entry}`);
  if (violations.length) throw new Error(violations.join("\n"));
  return found.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void auditDistribution(path.resolve("dist")).then(count => {
    console.log(`Distribution audit passed: ${count} allowlisted files.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

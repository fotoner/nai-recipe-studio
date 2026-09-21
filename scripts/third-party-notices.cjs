/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module */

const { readdir, readFile, realpath } = require("node:fs/promises");
const path = require("node:path");

/** Packages whose code, styles, or fonts end up inside the distributed app. */
const NOTICE_ROOTS = Object.freeze([
  "@base-ui/react",
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "@modelcontextprotocol/sdk",
  "better-sqlite3",
  "class-variance-authority",
  "cn",
  "i18next",
  "lucide-react",
  "react",
  "react-dom",
  "react-i18next",
  "shadcn",
  "tailwindcss",
  "tw-animate-css",
  "zod",
]);

/** Only a stylesheet is imported from these, so their own dependencies are not shipped. */
const STYLESHEET_ONLY = new Set(["shadcn", "tailwindcss", "tw-animate-css"]);

const HEADER = `NAI Recipe Studio includes third-party software under the licenses below.

Electron and Chromium notices ship next to the application executable
(LICENSE.electron.txt, LICENSES.chromium.html). The bundled Node.js runtime
license is mcp/NODE-LICENSE. SQLite, compiled into better-sqlite3, is in the
public domain. Geist and Lucide license files are in this directory.
`;

async function readManifest(directory) {
  try { return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); } catch { return null; }
}

/** Node-style lookup that also follows pnpm's symlinked sibling layout. */
async function findPackage(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.basename(directory) === "node_modules" ? path.join(directory, name) : path.join(directory, "node_modules", name);
    const manifest = await readManifest(candidate);
    if (manifest?.name === name) return { directory: await realpath(candidate), manifest };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function licenseTexts(directory) {
  const names = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)/i.test(name)).sort();
  const texts = [];
  for (const name of names) {
    try { texts.push((await readFile(path.join(directory, name), "utf8")).trim()); } catch { /* a directory named like a license file */ }
  }
  return texts;
}

function repositoryUrl(manifest) {
  const repository = manifest.repository;
  return (typeof repository === "string" ? repository : repository?.url)?.replace(/^git\+/, "").replace(/\.git$/, "");
}

async function collectPackages({ roots = NOTICE_ROOTS, projectRoot = process.cwd() } = {}) {
  const found = new Map();
  async function visit(name, fromDirectory, required) {
    const resolved = await findPackage(name, fromDirectory);
    if (!resolved) {
      if (required) throw new Error(`Third-party notice source is not installed: ${name}`);
      return;
    }
    const { directory, manifest } = resolved;
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) return;
    found.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === "string" ? manifest.license : "SEE LICENSE TEXT",
      repository: repositoryUrl(manifest),
      texts: await licenseTexts(directory),
    });
    if (STYLESHEET_ONLY.has(manifest.name)) return;
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency, directory, true);
    // Optional dependencies are platform-specific and may be legitimately absent.
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await visit(dependency, directory, false);
  }
  const start = await realpath(projectRoot);
  for (const root of roots) await visit(root, start, true);
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function renderNotices(packages) {
  const sections = packages.map(entry => [
    "=".repeat(78),
    `${entry.name}@${entry.version} (${entry.license})`,
    ...(entry.repository ? [entry.repository] : []),
    "",
    entry.texts.length ? entry.texts.join("\n\n") : `No license file is shipped with this package. It is distributed under ${entry.license}.`,
  ].join("\n"));
  return `${HEADER}\n${sections.join("\n\n")}\n`;
}

module.exports = { NOTICE_ROOTS, collectPackages, renderNotices };

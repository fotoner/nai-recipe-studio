import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { collectPackages, renderNotices } = require("./third-party-notices.cjs");

const output = path.resolve("desktop/release/licenses/THIRD-PARTY-NOTICES.txt");
const packages = await collectPackages();
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderNotices(packages));
console.log(`Third-party notices ready: ${packages.length} packages.`);

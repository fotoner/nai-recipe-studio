import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { bundleRuntime } = require("./runtime-bundler.cjs");

await bundleRuntime({
  platform: process.env.NAI_BUILD_PLATFORM ?? process.platform,
  arch: process.env.NAI_BUILD_ARCH ?? process.arch,
});

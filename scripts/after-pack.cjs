/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module */

const path = require("node:path");
const { bundleRuntime, targetCatalog } = require("./runtime-bundler.cjs");

const BUILDER_ARCH = new Map([
  [1, "x64"],
  [3, "arm64"],
]);

function bundleOptions(context) {
  const platform = context.electronPlatformName;
  const arch = BUILDER_ARCH.get(context.arch);
  const resourcesDirectory = context.packager?.getResourcesDir?.(context.appOutDir);
  if (!arch || !resourcesDirectory || !targetCatalog[`${platform}-${arch}`]) {
    throw new Error(`Unsupported Electron Builder runtime target: ${platform}/${String(context.arch)}`);
  }
  return {
    platform,
    arch,
    destination: path.join(resourcesDirectory, "mcp"),
    helperScript: path.resolve("dist/mcp/index.cjs"),
  };
}

function createAfterPack(runBundle = bundleRuntime) {
  return async context => runBundle(bundleOptions(context));
}

const afterPack = createAfterPack();
module.exports = afterPack;
module.exports.createAfterPack = createAfterPack;
module.exports.bundleOptions = bundleOptions;

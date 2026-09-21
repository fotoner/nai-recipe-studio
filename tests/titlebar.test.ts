import { describe, expect, it } from "vitest";
import { createBrowserWindowOptions } from "../desktop/main/window";
import { createStudioBridge } from "../desktop/preload";

const ipcRenderer = {
  invoke: async () => undefined,
  on() {},
  removeListener() {},
};

describe("native title bar platform options", () => {
  it("uses the inset native traffic lights only on macOS", () => {
    const mac = createBrowserWindowOptions("preload.cjs", { width: 1100, height: 760 }, "darwin");
    const windows = createBrowserWindowOptions("preload.cjs", { width: 1100, height: 760 }, "win32");

    expect(mac).toHaveProperty("titleBarStyle", "hiddenInset");
    expect(windows).not.toHaveProperty("titleBarStyle");
    expect(windows).not.toHaveProperty("titleBarOverlay");
  });

  it("exposes a read-only macOS flag through the preload bridge", () => {
    expect(createStudioBridge(ipcRenderer, "darwin").isMacOS).toBe(true);
    expect(createStudioBridge(ipcRenderer, "win32").isMacOS).toBe(false);
  });
});

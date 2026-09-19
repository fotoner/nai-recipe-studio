import { expect, type ElectronApplication } from "@playwright/test";

/** Exercise the native quit path and wait for the OS process to release files. */
export async function quitApplication(application: ElectronApplication) {
  const process = application.process();
  if (process.exitCode === null && process.signalCode === null) {
    await application.evaluate(({ app }) => {
      // Let the inspector call return before Electron starts closing its
      // windows and asynchronously drains the app-owned services.
      setImmediate(() => app.quit());
    });
    await expect.poll(() => ({ code: process.exitCode, signal: process.signalCode }), {
      message: "Electron must exit cleanly before its temporary profile is removed",
      timeout: 15_000,
    }).toEqual({ code: 0, signal: null });
  }
  await application.close();
}

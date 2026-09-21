import { expect, type ElectronApplication } from "@playwright/test";

/** Exercise the native quit path and wait for the OS process to release files. */
export async function quitApplication(application: ElectronApplication) {
  const child = application.process();
  if (child.exitCode === null && child.signalCode === null) {
    const diagnostics: string[] = [];
    const record = (chunk: Buffer) => { diagnostics.push(chunk.toString()); };
    child.stderr?.on("data", record);
    await application.evaluate(({ app }) => {
      for (const event of ["before-quit", "will-quit", "quit"]) {
        app.on(event as "quit", () => process.stderr.write(`[native-quit] ${event}\n`));
      }
      setTimeout(() => process.stderr.write(`[native-quit] pending ${JSON.stringify(process.getActiveResourcesInfo())}\n`), 1_000);
      // Let the inspector call return before Electron starts closing its
      // windows and asynchronously drains the app-owned services.
      setImmediate(() => app.quit());
    });
    try {
      await expect.poll(() => ({ code: child.exitCode, signal: child.signalCode }), {
        message: "Electron must exit cleanly before its temporary profile is removed",
        timeout: 15_000,
      }).toEqual({ code: 0, signal: null });
    } catch (error) {
      throw new Error(`${String(error)}\nNative shutdown diagnostics:\n${diagnostics.join("")}`, { cause: error });
    } finally {
      child.stderr?.off("data", record);
    }
  }
  await application.close();
}

/** Keep synthetic UI tests from taking keyboard input from the user's desktop. */
export async function keepTestAppInBackground(application: ElectronApplication) {
  await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setFocusable(false);
      window.hide();
    }
  });
}

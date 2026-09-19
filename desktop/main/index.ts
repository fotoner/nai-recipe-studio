import { startElectronApplication } from "./bootstrap";

void startElectronApplication().catch(error => {
  process.stderr.write(`[NAI Recipe Studio] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export * from "./bootstrap";

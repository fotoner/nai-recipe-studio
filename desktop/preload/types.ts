import type { Command, CommandInput, CommandOutput, StudioEvent } from "../../contracts/studio";

export type StudioBridge = {
  call<K extends Command>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  subscribe(listener: (event: StudioEvent) => void): () => void;
  openExternal(url: string): Promise<{ opened: boolean }>;
  getPaths(): Promise<{ userData: string; output: string }>;
  setWindowBounds(bounds: { width: number; height: number; x?: number; y?: number; maximized?: boolean }): Promise<{ saved: boolean }>;
};

export type ExposedWindow = Window & { studio: StudioBridge };

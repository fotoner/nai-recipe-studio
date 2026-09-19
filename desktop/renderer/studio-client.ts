import type { Command, CommandInput, CommandOutput, StudioClient } from "@/contracts/studio";

export function getStudioClient(): StudioClient | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { studio?: StudioClient }).studio;
}

/**
 * Keep the renderer on the command contract while allowing feature-local view
 * models to be mapped at the boundary. The preload remains the only owner of
 * IPC channel names and payload validation.
 */
export function studioCall<K extends Command>(client: StudioClient, command: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
  return client.call(command, input);
}

export function subscribeToStudio(client: StudioClient | undefined, listener: Parameters<StudioClient["subscribe"]>[0]): () => void {
  return client ? client.subscribe(listener) : () => undefined;
}

export function errorMessage(error: unknown, fallback = "errors.unknown"): string {
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: { messageKey?: string } }).data;
    if (data?.messageKey) return data.messageKey;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

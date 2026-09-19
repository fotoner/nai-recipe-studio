import {
  parseCommandInput,
  type CallContext,
  type Command,
  type CommandInput,
  type CommandOutput,
  type Connection,
  type StudioClient,
} from "../../contracts/studio";
import { PlatformError } from "./errors";

export type PlatformCallContext = CallContext & { senderId?: number; requestId?: string };
export type StudioService = StudioClient & {
  close?: () => Promise<void> | void;
  call: (command: Command, input: unknown, context?: PlatformCallContext) => Promise<unknown>;
};

const READ_COMMANDS = new Set<Command>([
  "status.read", "recipes.list", "recipes.get", "recipes.versions", "characters.list", "presets.list", "recipe.compose", "recipe.validate",
  "generation.pending", "generation.status", "generation.list", "gallery.list", "gallery.get", "settings.get", "ai.connections.list", "setup.inspect",
]);
const WRITE_COMMANDS = new Set<Command>([
  "recipes.save", "recipes.duplicate", "recipes.delete", "characters.save", "characters.delete", "presets.save", "presets.delete",
  "gallery.rate", "gallery.delete", "settings.update", "ai.connections.create", "ai.connections.revoke", "setup.install", "setup.uninstall",
]);
const UI_ONLY_COMMANDS = new Set<Command>([
  "generation.pending", "generation.approve", "credentials.set", "credentials.clear", "credentials.test", "files.importRecipe", "files.exportRecipe", "files.chooseOutput", "files.openOutput", "gallery.export", "help.open", "setup.install", "setup.uninstall",
]);
const IMAGE_COMMANDS = new Set<Command>(["gallery.export"]);
const GENERATION_COMMANDS = new Set<Command>(["generation.prepare", "generation.start", "generation.cancel"]);

export type DispatcherOptions = {
  service: StudioService;
  getConnection?: (id: string) => Connection | null;
};

/** Shared UI/MCP command boundary. Transport adapters never call the service directly. */
export class CommandDispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async call<K extends Command>(command: K, input: CommandInput<K>, context: PlatformCallContext): Promise<CommandOutput<K>> {
    const parsed = parseCommandInput(command, input);
    this.authorize(command, context);
    if (command === "generation.approve" && (context.source !== "ui" || context.senderId === undefined)) {
      throw new PlatformError("APPROVAL_REQUIRED", "Generation approval must be performed in the app.");
    }

    const output = await this.options.service.call(command, parsed, context) as CommandOutput<K>;
    return output;
  }

  private authorize(command: Command, context: PlatformCallContext) {
    const connection = context.connection;
    if (context.source === "mcp" && UI_ONLY_COMMANDS.has(command)) throw new PlatformError("PERMISSION_DENIED", "This command is available in the app only.");
    if (context.source === "mcp" && command === "generation.approve") throw new PlatformError("APPROVAL_REQUIRED", "Approve the generation plan in the app.");
    if (!connection) {
      if (context.source === "mcp") throw new PlatformError("PERMISSION_DENIED", "The MCP connection is not authorized.");
      return;
    }
    if (READ_COMMANDS.has(command) && !connection.permissions.read) throw new PlatformError("PERMISSION_DENIED");
    if (WRITE_COMMANDS.has(command) && !connection.permissions.write) throw new PlatformError("PERMISSION_DENIED");
    if (GENERATION_COMMANDS.has(command) && !connection.permissions.generate) throw new PlatformError("PERMISSION_DENIED");
    if (IMAGE_COMMANDS.has(command) && !connection.permissions.images) throw new PlatformError("PERMISSION_DENIED");
  }
}

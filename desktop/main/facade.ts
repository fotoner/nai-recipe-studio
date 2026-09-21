import { nativeText } from "./native-text";
import { Recipe } from "../../lib/schema";
import type { Command, CommandInput, CommandOutput, Connection, SetupTarget } from "../../contracts/studio";
import { exportPng, exportRecipeJson, importRecipeJson } from "./files";
import { CredentialStore } from "./credentials";
import { CommandDispatcher, type PlatformCallContext, type StudioService } from "./command-dispatch";
import { ConnectionStore } from "./connections";
import { PlatformError } from "./errors";
import { SetupManager } from "../../services/setup";
import { externalUrl } from "./window";
import type { WorkspaceBackupCoordinator } from "./workspace-backup";

export type MainFacadeOptions = {
  service: StudioService;
  dispatcher: CommandDispatcher;
  credentials: CredentialStore;
  connections: ConnectionStore;
  setup: SetupManager;
  dialog?: {
    openFile(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
    saveFile(options: unknown): Promise<{ canceled: boolean; filePath?: string }>;
    chooseDirectory(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  shell?: { openExternal(url: string): Promise<unknown>; openPath(path: string): Promise<string> };
  outputPath: string;
  workspaceBackup?: WorkspaceBackupCoordinator;
  readImage?: (id: number) => Promise<Uint8Array>;
};

export class MainCommandFacade {
  constructor(private readonly options: MainFacadeOptions) {}

  async call<K extends Command>(command: K, input: CommandInput<K>, context: PlatformCallContext): Promise<CommandOutput<K>> {
    if (command.startsWith("workspace.backup.")) {
      if (context.source !== "ui") throw new PlatformError("PERMISSION_DENIED");
      const backup = this.options.workspaceBackup;
      if (!backup) throw new PlatformError("NOT_SUPPORTED");
      if (command === "workspace.backup.export") return await backup.export() as CommandOutput<K>;
      if (command === "workspace.backup.inspect") return await backup.inspect((input as { stagingId?: string }).stagingId) as CommandOutput<K>;
      if (command === "workspace.backup.restore") return await backup.restore((input as { stagingId: string }).stagingId) as CommandOutput<K>;
    }
    if (command === "credentials.set") {
      await this.options.credentials.set("novelai", (input as { token: string }).token);
      return { connected: true } as CommandOutput<K>;
    }
    if (command === "credentials.clear") {
      await this.options.credentials.clear("novelai");
      return { connected: false } as CommandOutput<K>;
    }
    if (command === "credentials.test") return await this.options.service.call("status.read", {}, context) as CommandOutput<K>;
    if (command === "ai.connections.list") return await this.options.connections.list() as CommandOutput<K>;
    if (command === "ai.connections.create") {
      if (context.source !== "ui") throw new PlatformError("PERMISSION_DENIED");
      return await this.options.connections.create(input as { name: string; permissions: Connection["permissions"]; maxImages: number; maxAnlas: number }) as CommandOutput<K>;
    }
    if (command === "ai.connections.revoke") {
      if (context.source !== "ui") throw new PlatformError("PERMISSION_DENIED");
      return await this.options.connections.revoke((input as { id: string }).id) as CommandOutput<K>;
    }
    if (command === "setup.inspect") return await this.options.setup.inspect((input as { target: SetupTarget }).target) as CommandOutput<K>;
    if (command === "setup.install") {
      if (context.source !== "ui") throw new PlatformError("PERMISSION_DENIED");
      const connectionId = (input as { connectionId: string }).connectionId;
      const connection = await this.options.connections.get(connectionId);
      if (!connection) throw new PlatformError("PERMISSION_DENIED", "The selected AI connection is unavailable.");
      await this.options.connections.ensureToken(connection.id);
      return await this.options.setup.install({ target: (input as { target: SetupTarget }).target, connectionId }) as CommandOutput<K>;
    }
    if (command === "setup.uninstall") {
      if (context.source !== "ui") throw new PlatformError("PERMISSION_DENIED");
      return await this.options.setup.remove({ target: (input as { target: SetupTarget }).target }) as CommandOutput<K>;
    }
    if (command === "files.importRecipe") return await this.importRecipe() as unknown as CommandOutput<K>;
    if (command === "gallery.export") {
      const { id, includeMetadata } = input as CommandInput<"gallery.export">;
      if (!this.options.dialog || !this.options.readImage) return { saved: false } as CommandOutput<K>;
      const item = await this.options.service.call("gallery.get", { id }, context);
      const selection = await this.options.dialog.saveFile({ filters: [{ name: "PNG", extensions: ["png"] }], defaultPath: `image-${id}.png` });
      if (selection.canceled || !selection.filePath) return { saved: false } as CommandOutput<K>;
      await exportPng(selection.filePath, await this.options.readImage(id), includeMetadata ? item : undefined);
      return { saved: true } as CommandOutput<K>;
    }
    if (command === "files.exportRecipe") return await this.exportRecipe((input as { recipe: unknown }).recipe) as unknown as CommandOutput<K>;
    if (command === "files.chooseOutput") return await this.chooseOutput() as unknown as CommandOutput<K>;
    if (command === "files.openOutput") return await this.openOutput() as unknown as CommandOutput<K>;
    if (command === "help.open") return await this.openHelp((input as { page: "novelai" | "token" }).page) as unknown as CommandOutput<K>;
    return this.options.dispatcher.call(command, input, context);
  }

  private async text() {
    const settings = await this.options.service.call("settings.get", {}, { source: "ui" }) as CommandOutput<"settings.get">;
    return nativeText(settings.language);
  }

  private async importRecipe() {
    if (!this.options.dialog) return { recipe: null, warnings: ["FILE_DIALOG_UNAVAILABLE"] };
    const text = await this.text();
    const result = await this.options.dialog.openFile({ title: text.importRecipe, filters: [{ name: text.recipeJson, extensions: ["json"] }], properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return { recipe: null, warnings: [] };
    const recipe = await importRecipeJson(result.filePaths[0], value => Recipe.parse(value));
    return { recipe: { ...recipe, id: undefined, created_at: undefined, updated_at: undefined, source: "import:json" }, warnings: [] };
  }

  private async exportRecipe(recipe: unknown) {
    if (!this.options.dialog) return { saved: false };
    const text = await this.text();
    const result = await this.options.dialog.saveFile({ title: text.exportRecipe, filters: [{ name: text.recipeJson, extensions: ["json"] }], defaultPath: "recipe.json" });
    if (result.canceled || !result.filePath) return { saved: false };
    await exportRecipeJson(result.filePath, Recipe.parse(recipe));
    return { saved: true };
  }

  private async chooseOutput() {
    if (!this.options.dialog) return { path: null };
    const text = await this.text();
    const result = await this.options.dialog.chooseDirectory({ title: text.chooseOutput, properties: ["openDirectory", "createDirectory"] });
    return { path: result.canceled ? null : result.filePaths[0] ?? null };
  }

  private async openOutput() {
    if (!this.options.shell) return { opened: false };
    return { opened: !(await this.options.shell.openPath(this.options.outputPath)) };
  }

  private async openHelp(page: "novelai" | "token") {
    if (!this.options.shell) return { opened: false };
    const url = page === "token" ? "https://docs.novelai.net/en/text/usersettings/account/" : "https://novelai.net/";
    await this.options.shell.openExternal(externalUrl(url));
    return { opened: true };
  }
}

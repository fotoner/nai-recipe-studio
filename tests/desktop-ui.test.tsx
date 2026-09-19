import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandInput, type Command, type StudioClient } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { RendererApp } from "../features/app/AppShell";
import { GenerationFeature } from "../features/generation/GenerationFeature";
import { GalleryFeature } from "../features/gallery/GalleryFeature";
import { SettingsFeature } from "../features/settings/SettingsFeature";
import { newRecipe, type GalleryItem, type Recipe } from "../features/shared/types";

function storedRecipe(id = 7, name = "Morning recipe"): Recipe {
  return { ...newRecipe(name), id, version: 1, created_at: "2026-09-20T09:00:00.000Z", updated_at: "2026-09-20T09:00:00.000Z", tags: ["indoors"] };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const recipe = storedRecipe();
  const calls: string[] = [];
  const call = vi.fn(async (command: string, input: unknown) => {
    calls.push(command);
    parseCommandInput(command as Command, input);
    if (command === "settings.get") return { language: "en", blurSensitive: false, outputDirectory: "/tmp/output" };
    if (command === "settings.update") return { language: (input as { language?: string }).language ?? "en", blurSensitive: false, outputDirectory: "/tmp/output" };
    if (command === "status.read" || command === "credentials.test") return overrides[command] ?? { appVersion: "0.1.0", schemaVersion: 1, connected: false, account: null, dryRun: true, locale: "en" };
    if (command === "credentials.clear") return { connected: false };
    if (command === "recipes.list") return { items: [recipe], total: 1 };
    if (command === "recipes.get") return recipe;
    if (command === "recipes.save") return { ...recipe, ...(input as { recipe: Recipe }).recipe, id: recipe.id, version: 2 };
    if (command === "characters.list") return { items: [], total: 0 };
    if (command === "presets.list") return { items: [], total: 0 };
    if (command === "generation.prepare") return { id: "plan-1", recipe, count: 1, seeds: [42], estimatedAnlas: 10, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null };
    if (command === "generation.approve") return { id: "plan-1", recipe, count: 1, seeds: [42], estimatedAnlas: 10, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: true, account: null };
    if (command === "generation.start" || command === "generation.status") return { id: "job-1", planId: "plan-1", state: "running", total: 1, completed: 0, generationIds: [], created_at: "2026-09-20T09:00:00.000Z" };
    if (command === "gallery.list") return { items: [galleryItem()], total: 1 };
    if (command === "gallery.rate") return { ...galleryItem(), score: 5, liked: true };
    if (command === "setup.inspect") return { target: (input as { target: string }).target, available: true, mcpInstalled: false, skillInstalled: false, skillSupported: true, version: null, configPath: "/tmp/config", skillPath: null };
    if (command === "ai.connections.list") return [];
    if (command === "ai.connections.create") return { id: "connection-1", name: "Default", permissions: { read: true, write: true, generate: false, images: false }, maxImages: 0, maxAnlas: 0, created_at: "2026-09-20T09:00:00.000Z" };
    return overrides[command] ?? {};
  });
  const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
  return { client, call, calls };
}

function galleryItem(): GalleryItem {
  return { id: 12, recipe_id: 7, recipe_name: "Morning recipe", recipe: storedRecipe(), seed: 42, width: 832, height: 1216, rating: 0, url: "data:image/png;base64,fixture", created_at: "2026-09-20T09:00:00.000Z", estimatedAnlas: 10, score: null, liked: false, note: "", base_prompt: "indoors", negative: "official art" };
}

afterEach(async () => { await changeLanguage("en"); window.location.hash = ""; });

describe("desktop renderer command boundary", () => {
  it("loads settings once without a language-change reload loop", async () => {
    window.location.hash = "#/settings";
    const { client, call } = fakeClient();
    const original = call.getMockImplementation()!;
    let inspections = 0;
    call.mockImplementation(async (command, input) => {
      if (command === "setup.inspect" && ++inspections > 4) throw new Error("SETTINGS_RELOAD_LOOP");
      return original(command, input);
    });
    render(<RendererApp client={client} />);
    await screen.findByRole("heading", { name: "Language" });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(call.mock.calls.filter(([command]) => command === "setup.inspect").length).toBeLessThanOrEqual(4);
  });
  it("renders the recipe workspace from the client and routes to the editor", async () => {
    const { client, calls } = fakeClient();
    render(<RendererApp client={client} />);
    expect(await screen.findByRole("heading", { name: "Recipes" })).toBeInTheDocument();
    expect(screen.getByText("Morning recipe")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Morning recipe" })[0]);
    await waitFor(() => expect(window.location.hash).toBe("#/recipe/7"));
    expect(calls).toContain("recipes.list");
  });

  it("prepares a plan, requires approval, then starts a generation job", async () => {
    const { client, call, calls } = fakeClient();
    render(<GenerationFeature client={client} initialRecipe={storedRecipe()} onOpenGallery={vi.fn()} />);
    expect(await screen.findByText("Morning recipe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await waitFor(() => expect(screen.getByText(/Estimated use/)).toBeInTheDocument());
    expect(calls).toContain("generation.prepare");
    fireEvent.click(screen.getByRole("button", { name: "Approve and start" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.start", expect.objectContaining({ planId: "plan-1" })));
    expect(calls).toEqual(expect.arrayContaining(["generation.approve", "generation.start"]));
  });

  it("shows the MCP estimate and blocks approval when the cost is unknown", async () => {
    const plan = { id: "pending-1", recipe: storedRecipe(), count: 1, seeds: [42], estimatedAnlas: null, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null };
    const { client, call } = fakeClient({
      "generation.pending": [plan],
      "generation.list": [],
      "status.read": { appVersion: "0.1.0", schemaVersion: 1, connected: false, account: null, dryRun: false, locale: "en" },
    });
    render(<GenerationFeature client={client} onOpenGallery={vi.fn()} />);
    await screen.findByText("Waiting for approval");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pending-1" } });
    expect(screen.getByText(/Estimated cost: Generation settings need review/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeDisabled();
    expect(call).not.toHaveBeenCalledWith("generation.approve", { planId: "pending-1" });
  });

  it("requires paid confirmation before approving a paid MCP plan", async () => {
    const plan = { id: "paid-pending-1", recipe: storedRecipe(), count: 1, seeds: [42], estimatedAnlas: 12, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null };
    const { client, call } = fakeClient({
      "generation.pending": [plan],
      "generation.list": [],
      "status.read": { appVersion: "0.1.0", schemaVersion: 1, connected: true, account: null, dryRun: false, locale: "en" },
    });
    render(<GenerationFeature client={client} onOpenGallery={vi.fn()} />);
    await screen.findByText("Waiting for approval");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "paid-pending-1" } });
    const approve = screen.getByRole("button", { name: "Approve plan" });
    expect(screen.getByRole("checkbox", { name: /paid generation cost/i })).toBeInTheDocument();
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.approve", { planId: "paid-pending-1" }));
  });

  it("cancels the active job when stopping after the current recipe", async () => {
    const { client, call } = fakeClient();
    render(<GenerationFeature client={client} initialRecipe={storedRecipe()} onOpenGallery={vi.fn()} />);
    await screen.findByText("Morning recipe");
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await screen.findByRole("button", { name: "Approve and start" });
    fireEvent.click(screen.getByRole("button", { name: "Approve and start" }));
    await screen.findByRole("button", { name: "Stop after the current recipe" });
    fireEvent.click(screen.getByRole("button", { name: "Stop after the current recipe" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.cancel", { id: "job-1" }));
  });

  it("opens a full gallery view and sends rating changes through the client", async () => {
    const { client, call } = fakeClient();
    render(<GalleryFeature client={client} blurSensitive={false} onOpenRecipe={vi.fn()} />);
    fireEvent.click(await screen.findByTitle("Enlarge"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("gallery.rate", expect.objectContaining({ id: 12, score: 5 })));
  });

  it("changes language immediately and persists the preference through settings.update", async () => {
    const { client, call } = fakeClient();
    render(<SettingsFeature client={client} />);
    expect(await screen.findByRole("heading", { name: "Language" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("日本語"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "設定" })).toBeInTheDocument());
    expect(call).toHaveBeenCalledWith("settings.update", { language: "ja" });
  });

  it("clears the saved NovelAI token through the command boundary", async () => {
    const { client, call } = fakeClient({ "status.read": { appVersion: "0.1.0", schemaVersion: 1, connected: true, account: null, dryRun: false, locale: "en" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<SettingsFeature client={client} />);
      expect(await screen.findByRole("button", { name: "Remove token" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("credentials.clear", {}));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Remove token" })).not.toBeInTheDocument());
    } finally {
      confirm.mockRestore();
    }
  });
});

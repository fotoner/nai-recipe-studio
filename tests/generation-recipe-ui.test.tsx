import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, GalleryItem as StoredGalleryItem, GenerationJob, GenerationPlan, StudioClient } from "../contracts/studio";
import { parseCommandInput } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { GenerationResults } from "../features/generation/GenerationResults";
import { RecipeGenerateDialog, type RecipeGenerationState } from "../features/generation/RecipeGenerateDialog";
import { newRecipe, type Recipe } from "../features/shared/types";

const recipe = (): Recipe => ({ ...newRecipe("Synthetic recipe"), id: 7, version: 2 });
const job = (state: GenerationJob["state"], generationIds: number[] = [], completed = generationIds.length): GenerationJob => ({
  id: `job-${state}`, planId: "plan-current", state, total: 2, completed, generationIds,
  ...(state === "failed" ? { error: { code: "RATE_LIMITED", messageKey: "errors.RATE_LIMITED" } } : {}),
  created_at: "2026-09-20T10:00:00.000Z",
});
const galleryItem = (id: number, source = recipe()): StoredGalleryItem => ({
  id, recipe_id: source.id ?? null, recipe_name: source.name, recipe: source, seed: id + 100, width: 832, height: 1216,
  rating: 1, url: `data:image/png;base64,synthetic-${id}`, created_at: "2026-09-20T10:00:00.000Z", estimatedAnlas: 4,
  score: null, liked: false, note: "", base_prompt: "synthetic prompt", negative: "synthetic negative", characters: [],
});

function fakeClient(options: { estimate?: number | null; start?: GenerationJob; cancel?: GenerationJob } = {}) {
  const source = recipe();
  const calls: Array<{ command: string; input: unknown }> = [];
  const plans = new Map<string, GenerationPlan>();
  const call = vi.fn(async (command: string, input: unknown) => {
    parseCommandInput(command as Command, input);
    calls.push({ command, input });
    if (command === "generation.prepare") {
      const count = (input as { count: number }).count;
      const plan: GenerationPlan = { id: `plan-${count}`, recipe: source, count, seeds: Array.from({ length: count }, (_, index) => index + 42), estimatedAnlas: options.estimate ?? 12, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null };
      plans.set(plan.id, plan);
      return plan;
    }
    if (command === "generation.approve") return { ...plans.get((input as { planId: string }).planId)!, approved: true };
    if (command === "generation.start") return options.start ?? job("completed", [71, 72]);
    if (command === "generation.status") return options.start ?? job("completed", [71, 72]);
    if (command === "generation.cancel") return options.cancel ?? job("cancelled");
    if (command === "gallery.get") return galleryItem((input as { id: number }).id, source);
    if (command === "gallery.export") return { saved: true };
    if (command === "gallery.rate") return galleryItem((input as { id: number }).id, source);
    if (command === "settings.get") return { language: "en", blurSensitive: false, outputDirectory: "/tmp/output" };
    return {};
  });
  const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
  return { client, call, calls };
}

afterEach(async () => { await changeLanguage("en"); });

describe("recipe generation dialog", () => {
  it("binds paid consent to the exact recipe and count, then approves and starts from one action", async () => {
    await changeLanguage("en");
    const { client, call } = fakeClient();
    const onDone = vi.fn();
    render(<RecipeGenerateDialog client={client} recipe={recipe()} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByText("Estimated use: about 12 Anlas")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Images per run" }), { target: { value: "2" } });
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.prepare", expect.objectContaining({ count: 2 })));

    const start = screen.getByRole("button", { name: "Generate 2 images" });
    expect(start).toBeDisabled();
    expect(call).not.toHaveBeenCalledWith("generation.approve", expect.anything());
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.click(start);

    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.start", expect.objectContaining({ planId: "plan-2" })));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(call.mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining(["generation.prepare", "generation.approve", "generation.start", "gallery.get"]));
  });

  it("reports partial images from a failed job and allows cancellation of an active job", async () => {
    await changeLanguage("en");
    const failed = job("failed", [71], 1);
    const { client } = fakeClient({ estimate: 0, start: failed });
    const states: RecipeGenerationState[] = [];
    const onDone = vi.fn();
    const view = render(<RecipeGenerateDialog client={client} recipe={recipe()} onStateChange={state => states.push(state)} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate 1 image" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));
    await waitFor(() => expect(states.at(-1)).toMatchObject({ busy: false, items: [{ id: 71 }], error: "errors.RATE_LIMITED", job: { state: "failed" } }));
    expect(onDone).toHaveBeenCalledTimes(1);

    view.unmount();
    const active = job("running", [], 0);
    const cancelClient = fakeClient({ estimate: 0, start: active, cancel: job("cancelled") });
    render(<RecipeGenerateDialog client={cancelClient.client} recipe={recipe()} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate 1 image" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel generation" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    await waitFor(() => expect(cancelClient.call).toHaveBeenCalledWith("generation.cancel", { id: active.id }));
  });
});

describe("generation results", () => {
  it("keeps a large selected image, supports keyboard thumbnail selection, blur, and native export", async () => {
    await changeLanguage("en");
    const { client, call } = fakeClient();
    const items = [galleryItem(71), galleryItem(72)];
    render(<GenerationResults client={client} items={items} large blurSensitive />);

    const selection = screen.getByRole("group", { name: "Generation results" });
    expect(screen.getByRole("button", { name: "Select result 1, seed 171" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(selection, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Select result 2, seed 172" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: "Synthetic recipe" })).toHaveClass("blur-md");

    fireEvent.click(screen.getByRole("button", { name: "Open image 72" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("gallery.export", { id: 72, includeMetadata: false }));
  });
});

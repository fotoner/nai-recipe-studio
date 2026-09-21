import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Command, GenerationJob, GenerationPlan, StudioClient } from "../contracts/studio";
import { parseCommandInput } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { GenerationFeature } from "../features/generation/GenerationFeature";
import { newRecipe, type Recipe } from "../features/shared/types";

function storedRecipe(): Recipe {
  return { ...newRecipe("Synthetic generation"), id: 7, version: 2, tags: ["blue sky"] };
}

function generationJob(state: GenerationJob["state"], id = `job-${state}`, planId = "plan-ui-1"): GenerationJob {
  return { id, planId, state, total: 1, completed: state === "completed" ? 1 : 0, generationIds: [], created_at: "2026-09-20T10:00:00.000Z" };
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, resolve: (value: T) => settle?.(value) };
}

function fakeClient(options: {
  pendingPlans?: GenerationPlan[];
  recipePage?: (offset: number) => { items: Recipe[]; total: number };
  approveRequest?: (plan: GenerationPlan) => Promise<GenerationPlan>;
  startRequest?: (planId: string) => Promise<GenerationJob>;
  cancelRequest?: (id: string) => Promise<GenerationJob>;
} = {}) {
  const recipe = storedRecipe();
  const calls: string[] = [];
  const plans = new Map<string, GenerationPlan>();
  const call = vi.fn(async (command: string, input: unknown) => {
    calls.push(command);
    parseCommandInput(command as Command, input);
    if (command === "recipes.list") {
      const offset = (input as { offset?: number }).offset ?? 0;
      return options.recipePage?.(offset) ?? { items: [recipe], total: 1 };
    }
    if (command === "generation.pending") return options.pendingPlans ?? [];
    if (command === "generation.list") return [];
    if (command === "status.read") return { appVersion: "0.1.0", schemaVersion: 1, connected: true, account: null, dryRun: false, locale: "en" };
    if (command === "generation.prepare") {
      const plan: GenerationPlan = {
      id: "plan-ui-1", recipe: (input as { recipe?: Recipe }).recipe ?? recipe, count: (input as { count: number }).count, seeds: [42], estimatedAnlas: 12,
      findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null,
      };
      plans.set(plan.id, plan);
      return plan;
    }
    if (command === "generation.approve") {
      const plan = plans.get((input as { planId: string }).planId)!;
      return options.approveRequest ? options.approveRequest(plan) : { ...plan, approved: true };
    }
    if (command === "generation.start") {
      const planId = (input as { planId: string }).planId;
      return options.startRequest ? options.startRequest(planId) : { id: "job-ui-1", planId, state: "running", total: 1, completed: 0, generationIds: [], created_at: "2026-09-20T10:00:00.000Z" };
    }
    if (command === "generation.cancel") return options.cancelRequest ? options.cancelRequest((input as { id: string }).id) : generationJob("cancelled", (input as { id: string }).id);
    return {};
  });
  return { client: { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient, call, calls };
}

describe("standalone generation flow", () => {
  it("prepares the selected recipes automatically and starts from one paid-confirmed action", async () => {
    await changeLanguage("en");
    const { client, call, calls } = fakeClient();
    render(<GenerationFeature client={client} onOpenGallery={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Synthetic generation select" }));
    await waitFor(() => expect(screen.getByText("Estimated use: about 12 Anlas")).toBeInTheDocument());
    expect(call).toHaveBeenCalledWith("generation.prepare", expect.objectContaining({ count: 1 }));

    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.start", expect.objectContaining({ planId: "plan-ui-1" })));
    expect(calls).toEqual(expect.arrayContaining(["generation.prepare", "generation.approve", "generation.start"]));
    expect(screen.queryByRole("button", { name: "Prepare" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve and start" })).not.toBeInTheDocument();
  });

  it("loads recipes past the first page", async () => {
    await changeLanguage("en");
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ ...storedRecipe(), id: index + 1, name: `Recipe ${index + 1}` }));
    const lastRecipe = { ...storedRecipe(), id: 201, name: "Tail recipe" };
    const { client, call } = fakeClient({ recipePage: offset => offset === 0 ? { items: firstPage, total: 201 } : { items: [lastRecipe], total: 201 } });
    render(<GenerationFeature client={client} onOpenGallery={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Tail recipe select" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.list", { limit: 200, offset: 200 }));
    expect(call).toHaveBeenCalledWith("generation.prepare", expect.objectContaining({ recipe: expect.objectContaining({ id: 201 }), count: 1 }));
  });

  it("shows MCP plans for approval but hides locally prepared UI plans", async () => {
    await changeLanguage("en");
    const uiPlan: GenerationPlan = {
      id: "ui-plan", recipe: newRecipe("UI batch plan"), count: 1, seeds: [41], estimatedAnlas: 0,
      findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null,
    };
    const mcpPlan: GenerationPlan = {
      id: "mcp-plan", recipe: newRecipe("MCP plan"), count: 1, seeds: [42], estimatedAnlas: 0,
      findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: false, account: null, connectionId: "connection-1", connectionName: "Codex",
    };
    const { client } = fakeClient({ pendingPlans: [uiPlan, mcpPlan] });
    render(<GenerationFeature client={client} onOpenGallery={vi.fn()} />);

    const planPicker = await screen.findByRole("combobox", { name: "Prepared plan" });
    const planOptions = within(planPicker).getAllByRole("option").map(option => option.textContent);
    expect(planOptions).toContain("MCP plan · Images: 1");
    expect(planOptions).not.toContain("UI batch plan · Images: 1");
  });

  it("does not start a plan when stopped while approval is still pending", async () => {
    await changeLanguage("en");
    const approval = deferred<GenerationPlan>();
    const { client, call } = fakeClient({ approveRequest: () => approval.promise });
    render(<GenerationFeature client={client} initialRecipe={storedRecipe()} onOpenGallery={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Estimated use: about 12 Anlas")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.approve", expect.objectContaining({ planId: "plan-ui-1", allowPaid: true })));

    fireEvent.click(screen.getByRole("button", { name: "Stop after the current recipe" }));
    await act(async () => { approval.resolve({ id: "plan-ui-1", recipe: storedRecipe(), count: 1, seeds: [42], estimatedAnlas: 12, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: true, account: null }); await approval.promise; });

    expect(call).not.toHaveBeenCalledWith("generation.start", expect.anything());
  });

  it("does not start an approved plan after the generation view unmounts", async () => {
    await changeLanguage("en");
    const approval = deferred<GenerationPlan>();
    const { client, call } = fakeClient({ approveRequest: () => approval.promise });
    const view = render(<GenerationFeature client={client} initialRecipe={storedRecipe()} onOpenGallery={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Estimated use: about 12 Anlas")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.approve", expect.objectContaining({ planId: "plan-ui-1", allowPaid: true })));

    view.unmount();
    await act(async () => { approval.resolve({ id: "plan-ui-1", recipe: storedRecipe(), count: 1, seeds: [42], estimatedAnlas: 12, findings: [], expiresAt: "2099-01-01T00:00:00.000Z", approved: true, account: null }); await approval.promise; });

    expect(call).not.toHaveBeenCalledWith("generation.start", expect.anything());
  });

  it("cancels a job that arrives after stop is requested during start", async () => {
    await changeLanguage("en");
    const start = deferred<GenerationJob>();
    const { client, call } = fakeClient({
      startRequest: () => start.promise,
      cancelRequest: async id => generationJob("cancelled", id),
    });
    render(<GenerationFeature client={client} initialRecipe={storedRecipe()} onOpenGallery={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Estimated use: about 12 Anlas")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: /paid generation cost/i }));
    fireEvent.click(screen.getByRole("button", { name: "Generate 1 image" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.start", expect.objectContaining({ planId: "plan-ui-1" })));

    fireEvent.click(screen.getByRole("button", { name: "Stop after the current recipe" }));
    await act(async () => { start.resolve(generationJob("running", "late-job")); await start.promise; });

    await waitFor(() => expect(call).toHaveBeenCalledWith("generation.cancel", { id: "late-job" }));
  });
});

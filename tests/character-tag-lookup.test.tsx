import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { StudioClient, TagSuggestion } from "../contracts/studio";
import { i18n, changeLanguage } from "../i18n";
import { CharactersFeature } from "../features/characters/CharactersFeature";
import { CharacterForm, emptyCharacter } from "../features/characters/CharacterComponents";

function renderWithI18n(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

const characterTags: TagSuggestion[] = [
  { name: "Sample Character", tag: "sample_character", post_count: 42, category: 4 },
];
const relatedTags: TagSuggestion[] = [
  { name: "Sample Series", tag: "sample_series", post_count: 1000, category: 3, frequency: 4.5 },
  { name: "Alternate Series", tag: "alternate_series", post_count: 500, category: 3, frequency: 1.2 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function tagClient() {
  const call = vi.fn(async (command: string, input: unknown) => {
    if (command === "characters.list") return { items: [], total: 0 };
    if (command === "characters.tagLookup") {
      const request = input as { mode: string; query?: string; kind?: string; tag?: string };
      return request.mode === "related" ? relatedTags : characterTags;
    }
    return {};
  });
  return { client: { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient, call };
}

afterEach(async () => {
  vi.useRealTimers();
  await changeLanguage("en");
});

describe("character Danbooru lookup", () => {
  it("debounces tag suggestions, auto-fills related series, and lets the user choose another candidate", async () => {
    await changeLanguage("en");
    vi.useFakeTimers();
    const { client, call } = tagClient();
    renderWithI18n(<CharactersFeature client={client} />);

    fireEvent.click(screen.getByRole("button", { name: "Register character" }));
    const tagInput = screen.getByRole("textbox", { name: "Character tag" });
    fireEvent.change(tagInput, { target: { value: "Sample" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(call).not.toHaveBeenCalledWith("characters.tagLookup", { mode: "search", query: "Sample", kind: "character" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(call).toHaveBeenCalledWith("characters.tagLookup", { mode: "search", query: "Sample", kind: "character" });
    fireEvent.keyDown(tagInput, { key: "ArrowDown" });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(call).toHaveBeenCalledWith("characters.tagLookup", { mode: "related", tag: "Sample Character" });
    expect(tagInput).toHaveValue("Sample Character");

    const seriesInput = screen.getByRole("textbox", { name: "Series" });
    expect(seriesInput).toHaveValue("Sample Series");
    fireEvent.click(screen.getByRole("button", { name: "Alternate Series" }));
    expect(seriesInput).toHaveValue("Alternate Series");
  });

  it("ignores a related-series response after the character tag or manual series changes", async () => {
    await changeLanguage("en");
    const pending: { tag: string; result: ReturnType<typeof deferred<TagSuggestion[]>> }[] = [];
    const call = vi.fn((command: string, input: unknown) => {
      if (command === "characters.tagLookup") {
        const request = input as { mode: string; tag?: string };
        if (request.mode === "related") {
          const result = deferred<TagSuggestion[]>();
          pending.push({ tag: request.tag ?? "", result });
          return result.promise;
        }
      }
      return Promise.resolve([]);
    });
    const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
    const value = { ...emptyCharacter(), tag: "Alpha Character" };
    renderWithI18n(<CharacterForm value={value} onSubmit={vi.fn()} onCancel={vi.fn()} client={client} />);

    fireEvent.click(screen.getByRole("button", { name: "Find series for this tag" }));
    expect(pending.map(item => item.tag)).toEqual(["Alpha Character"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Character tag" }), { target: { value: "Beta Character" } });
    await act(async () => { pending[0].result.resolve([{ name: "Alpha Series", tag: "alpha_series", post_count: 10, category: 3 }]); await pending[0].result.promise; });
    expect(screen.getByRole("textbox", { name: "Series" })).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Find series for this tag" }));
    expect(pending.map(item => item.tag)).toEqual(["Alpha Character", "Beta Character"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Series" }), { target: { value: "Manual series" } });
    await act(async () => { pending[1].result.resolve([{ name: "Beta Series", tag: "beta_series", post_count: 20, category: 3 }]); await pending[1].result.promise; });
    expect(screen.getByRole("textbox", { name: "Series" })).toHaveValue("Manual series");
  });
});

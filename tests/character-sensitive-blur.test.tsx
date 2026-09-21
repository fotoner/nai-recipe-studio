import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { GenerationExample, Settings, StoredCharacter, StudioClient, StudioEvent } from "../contracts/studio";
import { i18n } from "../i18n";
import { CharactersFeature } from "../features/characters/CharactersFeature";

const example: GenerationExample = {
  id: 9,
  recipe_id: 2,
  seed: 123,
  created_at: "2026-09-20T10:00:00.000Z",
  rating: 1,
  url: "recipe-studio://app/images/9",
};
const character: StoredCharacter = {
  id: 7,
  tag: "synthetic_character",
  series: "Synthetic series",
  display_name: "Synthetic Character",
  gender: "other",
  age_flag: "adult",
  locked: false,
  fixed_traits: [],
  default_x: 0.5,
  default_y: 0.5,
  notes: "",
  created_at: "2026-09-19T10:00:00.000Z",
  generation_count: 1,
  examples: [example],
};

describe("character example blur preference", () => {
  it("blurs sensitive thumbnails and reacts to global blur setting changes", async () => {
    let listener: ((event: StudioEvent) => void) | undefined;
    const call = vi.fn(async (command: string) => {
      if (command === "characters.list") return { items: [character], total: 1 };
      if (command === "settings.get") return { language: "en", blurSensitive: true, outputDirectory: "" };
      return {};
    });
    const client = {
      call,
      subscribe: vi.fn((next: (event: StudioEvent) => void) => { listener = next; return () => { listener = undefined; }; }),
    } as unknown as StudioClient;
    render(<I18nextProvider i18n={i18n}><CharactersFeature client={client} /></I18nextProvider>);

    const thumbnail = await screen.findByAltText("synthetic_character");
    await waitFor(() => expect(thumbnail).toHaveClass("blur-md"));
    const settings: Settings = { language: "en", blurSensitive: false, outputDirectory: "" };
    act(() => listener?.({ type: "settings.changed", settings }));
    await waitFor(() => expect(thumbnail).not.toHaveClass("blur-md"));
  });
});

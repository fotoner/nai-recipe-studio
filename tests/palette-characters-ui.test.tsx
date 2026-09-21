import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { GenerationExample, StoredCharacter, StudioClient } from "../contracts/studio";
import { i18n, changeLanguage } from "../i18n";
import { PaletteFeature } from "../features/palette/PaletteFeature";
import { BlockEditor } from "../features/palette/PaletteComponents";
import { CharactersFeature } from "../features/characters/CharactersFeature";
import { newBlock } from "../features/shared/types";

function renderWithI18n(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

const examples: GenerationExample[] = Array.from({ length: 4 }, (_, index) => ({
  id: 301 + index,
  recipe_id: null,
  seed: 42 + index,
  created_at: `2026-09-${19 - index}T09:00:00.000Z`,
  rating: 0,
  url: `data:image/png;base64,example-${301 + index}`,
}));

function fakeClient({ includeAggregateMetadata = true }: { includeAggregateMetadata?: boolean } = {}) {
  const calls: Array<{ command: string; input: unknown }> = [];
  const preset = {
    id: 7,
    type: "style" as const,
    name: "Neutral style",
    block: newBlock("style"),
    tags: ["clean"],
    notes: "A reusable neutral style",
    created_at: "2026-09-18T09:00:00.000Z",
    updated_at: "2026-09-18T09:00:00.000Z",
    ...(includeAggregateMetadata ? { usage: 245, examples } : {}),
  };
  const character: StoredCharacter = {
    id: 3,
    tag: "sample_character",
    series: "Sample series",
    display_name: "Sample Character",
    gender: "girl",
    age_flag: "adult",
    locked: false,
    fixed_traits: ["short hair"],
    default_x: 0.5,
    default_y: 0.5,
    notes: "",
    created_at: "2026-09-18T09:00:00.000Z",
    ...(includeAggregateMetadata ? { generation_count: 245, examples } : {}),
  };
  const call = vi.fn(async (command: string, input: unknown) => {
    calls.push({ command, input });
    if (command === "presets.list") return { items: [preset], total: 1 };
    if (command === "characters.list") return { items: [character], total: 1 };
    if (command === "gallery.list") {
      return {
        items: [{
          id: 11,
          recipe_id: null,
          recipe_name: "Example recipe",
          recipe: { name: "Example recipe", tags: [], rating: 0, blocks: [{ ...newBlock("style"), preset_id: 7 }, { ...newBlock("cast"), members: [{ character_id: 3, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }] }], source: "manual", notes: "" },
          seed: 42,
          width: 832,
          height: 1216,
          rating: 0,
          url: "data:image/png;base64,fixture",
          created_at: "2026-09-19T09:00:00.000Z",
          estimatedAnlas: 0,
          score: null,
          liked: false,
          note: "",
          base_prompt: "",
          negative: "",
        }],
        total: 1,
      };
    }
    if (command === "presets.save") return { ...preset, ...(input as { preset: object }).preset };
    if (command === "characters.save") return { ...character, ...(input as { character: object }).character };
    if (command.endsWith(".delete")) return { deleted: true };
    return {};
  });
  return { client: { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient, call, calls };
}

afterEach(async () => {
  await changeLanguage("en");
  window.location.hash = "";
});

describe("palette and character library views", () => {
  it("keeps the artist input focused while editing its name", () => {
    function Editor() {
      const [block, setBlock] = React.useState({ ...newBlock("style"), type: "style" as const, artists: [{ name: "sample", weight: 1 }], year: "", quality: [], minus: [] });
      return <BlockEditor block={block} characters={[]} onChange={next => setBlock(next as typeof block)} />;
    }
    renderWithI18n(<Editor />);
    const input = screen.getByDisplayValue("sample");
    input.focus();
    fireEvent.change(input, { target: { value: "sample artist" } });
    expect(screen.getByDisplayValue("sample artist")).toHaveFocus();
  });
  it("shows preset examples and saves an edited preset through the command client", async () => {
    const { client, call, calls } = fakeClient();
    renderWithI18n(<PaletteFeature client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /Style/ }));
    expect(await screen.findByText("Neutral style")).toBeInTheDocument();
    expect(screen.getByText("245 images")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Example generated with Neutral style" })).toHaveAttribute("src", examples[0].url);
    expect(calls.some(({ command }) => command === "gallery.list")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit preset" }));
    const name = await screen.findByDisplayValue("Neutral style");
    fireEvent.change(name, { target: { value: "Edited style" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("presets.save", expect.objectContaining({
      preset: expect.objectContaining({ id: 7, name: "Edited style", type: "style" }),
    })));
    expect(calls.some(({ command }) => command === "gallery.list")).toBe(false);
  });

  it("defaults missing preset aggregate metadata to zero and no examples", async () => {
    const { client, calls } = fakeClient({ includeAggregateMetadata: false });
    const { container } = renderWithI18n(<PaletteFeature client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /Style/ }));
    expect(await screen.findByText("Neutral style")).toBeInTheDocument();
    expect(screen.getByText("0 images")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(calls.some(({ command }) => command === "gallery.list")).toBe(false);
  });

  it("keeps the original Korean palette page name", async () => {
    await changeLanguage("ko");
    const { client } = fakeClient();
    renderWithI18n(<PaletteFeature client={client} />);

    expect(await screen.findByRole("heading", { name: "블록 팔레트" })).toBeInTheDocument();
  });

  it("shows presets returned on later pages", async () => {
    const first = {
      id: 17,
      type: "style" as const,
      name: "First style",
      block: newBlock("style"),
      tags: [],
      notes: "",
      created_at: "2026-09-18T09:00:00.000Z",
      updated_at: "2026-09-18T09:00:00.000Z",
    };
    const second = { ...first, id: 18, name: "Second style" };
    const call = vi.fn(async (command: string, input: unknown) => {
      if (command === "presets.list") {
        const offset = (input as { offset?: number }).offset ?? 0;
        return offset === 0 ? { items: [first], total: 2 } : { items: [second], total: 2 };
      }
      if (command === "characters.list" || command === "gallery.list") return { items: [], total: 0 };
      return {};
    });
    const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
    window.location.hash = "#/palette?type=style";

    renderWithI18n(<PaletteFeature client={client} />);

    expect((await screen.findAllByText("Second style")).length).toBeGreaterThan(0);
    expect(call).not.toHaveBeenCalledWith("gallery.list", expect.anything());
  });

  it("keeps the original character card/table flow and saves edited character data", async () => {
    const { client, call } = fakeClient();
    renderWithI18n(<CharactersFeature client={client} />);

    expect(await screen.findByText("sample_character")).toBeInTheDocument();
    expect(screen.getAllByAltText("sample_character")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("columnheader", { name: "Character tag" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const tag = await screen.findByDisplayValue("sample_character");
    fireEvent.change(tag, { target: { value: "renamed_character" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("characters.save", expect.objectContaining({
      character: expect.objectContaining({ id: 3, tag: "renamed_character" }),
    })));
  });

  it("uses image units for generated character counts", async () => {
    await changeLanguage("ko");
    const { client, calls } = fakeClient();
    const { container } = renderWithI18n(<CharactersFeature client={client} />);

    expect(await screen.findByText("sample_character")).toBeInTheDocument();
    expect(screen.getByText("245장")).toBeInTheDocument();
    expect(screen.getAllByAltText("sample_character")).toHaveLength(4);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(examples[0].url);
    expect(calls.some(({ command }) => command === "gallery.list")).toBe(false);
  });

  it("defaults missing character aggregate metadata to zero and no examples", async () => {
    await changeLanguage("ko");
    const { client, calls } = fakeClient({ includeAggregateMetadata: false });
    const { container } = renderWithI18n(<CharactersFeature client={client} />);

    expect(await screen.findByText("sample_character")).toBeInTheDocument();
    expect(screen.getByText("0장")).toBeInTheDocument();
    expect(screen.queryByAltText("sample_character")).not.toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(calls.some(({ command }) => command === "gallery.list")).toBe(false);
  });
});

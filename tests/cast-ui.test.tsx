import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n";
import type { StudioClient, StoredPreset } from "../contracts/studio";
import { BlockPicker } from "../features/cast/BlockPicker";
import { CastEditor } from "../features/cast/CastEditor";
import { CharacterPicker } from "../features/cast/CharacterPicker";
import { newBlock, type Block, type Character } from "../features/shared/types";

const character = (id: number, tag: string): Character => ({
  id,
  tag,
  series: "Sample series",
  display_name: `Sample ${id}`,
  gender: "girl",
  age_flag: "adult",
  locked: false,
  fixed_traits: [],
  default_x: 0.5,
  default_y: 0.5,
  notes: "",
});

function fakeClient(preset: StoredPreset) {
  const call = vi.fn(async (command: string) => {
    if (command === "presets.list") return { items: [preset], total: 1 };
    if (command === "gallery.list") return { items: [], total: 0 };
    throw new Error(`Unexpected command ${command}`);
  }) as StudioClient["call"];
  return {
    client: {
      call,
      subscribe: vi.fn(() => () => undefined),
    } as StudioClient,
    call,
  };
}

beforeEach(async () => { await changeLanguage("ko"); });
afterEach(async () => { await changeLanguage("en"); });

describe("standalone cast editor", () => {
  it("translates picker controls while keeping character names unchanged", async () => {
    await changeLanguage("en");
    render(<CharacterPicker characters={[character(1, "sample_one")]} selectedIds={[]} onAdd={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add character" }));
    expect(await screen.findByRole("button", { name: "Add: Sample 1" })).toBeInTheDocument();
  });
  it("keeps the character picker open while adding distinct members", async () => {
    const onAdd = vi.fn();
    render(<CharacterPicker characters={[character(1, "sample_one"), character(2, "sample_two")]} selectedIds={[]} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole("button", { name: "캐릭터 추가" }));
    expect(await screen.findByRole("searchbox", { name: "캐릭터 검색" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "추가: Sample 1" }));
    fireEvent.click(screen.getByRole("button", { name: "추가: Sample 2" }));

    expect(onAdd).toHaveBeenNthCalledWith(1, 1);
    expect(onAdd).toHaveBeenNthCalledWith(2, 2);
    expect(screen.getByText("0/6명 선택됨")).toBeInTheDocument();
  });

  it("loads injected presets and preserves the preset reference when picked", async () => {
    const preset: StoredPreset = {
      id: 11,
      type: "outfit",
      name: "Neutral outfit",
      block: { type: "outfit", tags: ["jacket"], text: "" },
      tags: ["neutral"],
      notes: "A reusable outfit",
      created_at: "2026-09-18T09:00:00.000Z",
      updated_at: "2026-09-18T09:00:00.000Z",
      usage: 245,
      examples: Array.from({ length: 4 }, (_, index) => ({
        id: 501 + index,
        recipe_id: null,
        seed: 87 + index,
        created_at: `2026-09-${19 - index}T09:00:00.000Z`,
        rating: 0,
        url: `data:image/png;base64,picker-example-${501 + index}`,
      })),
    };
    const onPick = vi.fn();
    const { client, call } = fakeClient(preset);
    render(<BlockPicker client={client} type="outfit" onOpenChange={vi.fn()} onPick={onPick} />);

    fireEvent.click(await screen.findByRole("button", { name: /Neutral outfit/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ type: "outfit", preset_id: 11, tags: ["jacket"] }));
    expect(screen.getByText("245장")).toBeInTheDocument();
    expect(document.body.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,picker-example-501");
    expect(call).not.toHaveBeenCalledWith("gallery.list", expect.anything());
  });

  it("keeps a preset usable without optional aggregate metadata", async () => {
    const preset: StoredPreset = {
      id: 12,
      type: "outfit",
      name: "Fallback outfit",
      block: { type: "outfit", tags: ["coat"], text: "" },
      tags: [],
      notes: "",
      created_at: "2026-09-18T09:00:00.000Z",
      updated_at: "2026-09-18T09:00:00.000Z",
    };
    const { client, call } = fakeClient(preset);
    render(<BlockPicker client={client} type="outfit" onOpenChange={vi.fn()} onPick={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Fallback outfit/ })).toBeInTheDocument();
    expect(document.body.querySelector("img")).toBeNull();
    expect(call).not.toHaveBeenCalledWith("gallery.list", expect.anything());
  });

  it("updates the cast block for layout choices and dragged coordinates", async () => {
    const initial = newBlock("cast") as Extract<Block, { type: "cast" }>;
    const member = { character_id: 1, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] };
    const start: Extract<Block, { type: "cast" }> = { ...initial, members: [member] };
    const changes: Array<Extract<Block, { type: "cast" }>> = [];
    function Harness() {
      const [block, setBlock] = React.useState(start);
      return <CastEditor block={block} characters={[character(1, "sample_one"), character(2, "sample_two")]} rating={0} onChange={(next) => { changes.push(next); setBlock(next); }} />;
    }
    render(<Harness />);

    expect(screen.getByRole("button", { name: "솔로" })).toBeInTheDocument();
    for (const label of ["traits", "outfit", "expression", "uc", "interactions"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "나란히" }));
    expect(changes.at(-1)?.layout_preset).toBe("side_by_side");

    const marker = screen.getByTitle(/0\.50,0\.50/);
    const canvas = marker.parentElement;
    expect(canvas).toBeTruthy();
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200 }) });
    fireEvent.pointerDown(marker, { clientX: 20, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 75, clientY: 100 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(changes.at(-1)?.layout_preset).toBe("custom"));
    expect(changes.at(-1)?.members[0]).toEqual(expect.objectContaining({ x: 0.75, y: 0.5 }));
  });
});

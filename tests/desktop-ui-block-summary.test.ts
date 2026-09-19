import { describe, expect, it } from "vitest";
import { blockSummary, newBlock, type Block } from "../features/shared/types";

describe("block summaries", () => {
  it("keeps the original Korean editor summary shape", () => {
    const style = newBlock("style");
    const cast = newBlock("cast");
    const negative = newBlock("negative");
    const settings = newBlock("settings");
    const text = { ...newBlock("text"), entries: [{ kind: "speech" as const, text: "Hello!" }] };

    expect(blockSummary(style, "ko")).toBe("작가 없음");
    expect(blockSummary(cast, "ko")).toBe("0인 · 솔로");
    expect(blockSummary(negative, "ko")).toBe("등급 0 · heavy + 2");
    expect(blockSummary(settings, "ko")).toBe("832×1216 · 28스텝 · random");
    expect(blockSummary(text, "ko")).toBe("말풍선: Hello!");
  });

  it("localizes labels while preserving user-authored block values", () => {
    const style = { ...newBlock("style"), artists: [{ name: "artist", weight: 0.9 }] };
    const cast = { ...newBlock("cast"), members: [{ character_id: 1, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }] };
    const text = { ...newBlock("text"), entries: [{ kind: "speech" as const, text: "ユーザーの文" }] };

    expect(blockSummary(style, "en")).toBe("artist 0.9");
    expect(blockSummary(cast, "en")).toBe("1 member · Solo");
    expect(blockSummary(cast, "ja")).toBe("1人 · ソロ");
    expect(blockSummary(text, "ja")).toBe("セリフ: ユーザーの文");
  });

  it("uses the original empty summaries for tag and adult blocks", () => {
    const scene = newBlock("scene");
    const nsfw = newBlock("nsfw");
    const filled = { ...scene, tags: ["user tag"], text: "user text" } as Block;

    expect(blockSummary(scene, "ko")).toBe("비어 있음");
    expect(blockSummary(nsfw, "ko")).toBe("비어 있음");
    expect(blockSummary(filled, "ko")).toBe("user tag / user text");
  });
});

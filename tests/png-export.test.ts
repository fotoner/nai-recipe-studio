import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportPng } from "../desktop/main/files";
import { stripPngMetadata } from "../desktop/main/png";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("sharing image exports", () => {
  it("includes generation information only when explicitly requested", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "nai-export-")); folders.push(folder);
    const included = path.join(folder, "with-info.png");
    await exportPng(included, pixel, { notes: "Synthetic user notes 한국어", seed: 17 });
    const annotated = await readFile(included);
    expect(annotated.toString("utf8")).toContain("Synthetic user notes 한국어");
    expect(stripPngMetadata(annotated)).toEqual(pixel);
    const shared = path.join(folder, "shared.png");
    await exportPng(shared, annotated);
    expect(await readFile(shared)).toEqual(pixel);
  });
});

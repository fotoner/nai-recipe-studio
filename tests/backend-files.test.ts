import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OutputStore } from "../adapters/files";

const PNG = new Uint8Array([1, 2, 3]);

describe("output storage boundary", () => {
  it("rejects traversal with either path separator", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-recipe-studio-output-"));
    const store = new OutputStore(root);
    try {
      await expect(store.write("../outside.png", PNG)).rejects.toThrow();
      await expect(store.write("..\\outside.png", PNG)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute POSIX and Windows paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-recipe-studio-output-"));
    const store = new OutputStore(root);
    try {
      await expect(store.write("/tmp/outside.png", PNG)).rejects.toThrow();
      await expect(store.write("C:\\outside.png", PNG)).rejects.toThrow();
      await expect(store.write("\\\\server\\share\\outside.png", PNG)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow a directory symlink outside the output root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-recipe-studio-output-"));
    const outside = await mkdtemp(path.join(tmpdir(), "nai-recipe-studio-outside-"));
    const store = new OutputStore(root);
    try {
      await symlink(outside, path.join(root, "linked"), "dir");
      await expect(store.write("linked/escape.png", PNG)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the image when a sidecar cannot be removed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nai-recipe-studio-output-"));
    const store = new OutputStore(root);
    try {
      await store.write("images/result.png", PNG, { source: "fixture" });
      await rm(path.join(root, "images", "result.json"));
      await mkdir(path.join(root, "images", "result.json"));

      await expect(store.remove("images/result.png")).rejects.toThrow();
      await expect(readFile(path.join(root, "images", "result.png"))).resolves.toEqual(Buffer.from(PNG));
      await expect(lstat(path.join(root, "images", "result.json"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

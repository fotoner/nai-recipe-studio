import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StudioSqliteStore } from "../adapters/sqlite";

async function tempProfile() {
  return mkdtemp(path.join(tmpdir(), "nai-recipe-studio-schema-"));
}

describe("SQLite schema boundary", () => {
  it("marks a fresh profile as schema version 2", async () => {
    const dataDir = await tempProfile();
    const store = new StudioSqliteStore(dataDir);
    try {
      expect(Number(store.db.pragma("user_version", { simple: true }))).toBe(2);
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recipe_proposals'").get()).toEqual({ name: "recipe_proposals" });
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses a newer schema before creating or changing product tables", async () => {
    const dataDir = await tempProfile();
    const dbPath = path.join(dataDir, "studio.db");
    const seeded = new Database(dbPath);
    seeded.pragma("user_version = 99");
    seeded.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
    seeded.close();

    try {
      expect(() => new StudioSqliteStore(dataDir)).toThrow(/newer.*schema|unsupported.*schema/i);
      const check = new Database(dbPath);
      try {
        expect(Number(check.pragma("user_version", { simple: true }))).toBe(99);
        expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'").get()).toBeUndefined();
        expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sentinel'").get()).toEqual({ name: "sentinel" });
      } finally {
        check.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

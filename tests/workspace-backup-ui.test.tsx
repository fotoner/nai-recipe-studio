import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "../contracts/studio";
import type { WorkspaceBackupCounts, WorkspaceBackupPreview } from "../contracts/workspace-backup";
import { changeLanguage } from "../i18n";
import { WorkspaceBackup } from "../features/settings/WorkspaceBackup";

const counts: WorkspaceBackupCounts = { recipes: 2, recipeVersions: 3, characters: 1, presets: 4, galleryItems: 5, images: 4 };
const emptyCounts: WorkspaceBackupCounts = { recipes: 0, recipeVersions: 0, characters: 0, presets: 0, galleryItems: 0, images: 0 };

function fixture(preview: WorkspaceBackupPreview) {
  const call = vi.fn(async (command: string, _input: unknown) => {
    if (command === "workspace.backup.export") return { saved: true, counts, missingFiles: 0 };
    if (command === "workspace.backup.inspect") return { preview };
    if (command === "workspace.backup.restore") return { restored: counts, skipped: emptyCounts, alreadyImported: false };
    return {};
  });
  return { call, client: { call, subscribe: () => () => undefined } as unknown as StudioClient };
}

beforeEach(async () => { await changeLanguage("en"); });

describe("workspace backup controls", () => {
  it("shows the reviewed archive counts before additive restore and consumes its staging ticket", async () => {
    const preview: WorkspaceBackupPreview = {
      stagingId: "5edb9a4d-8a81-4b18-8c77-b676e5108d22",
      backupId: "a".repeat(64),
      createdAt: "2026-09-20T07:00:00.000Z",
      appVersion: "0.1.0",
      archiveBytes: 4096,
      counts,
      duplicates: { recipes: 1, recipeVersions: 0, characters: 0, presets: 1, galleryItems: 0, images: 0 },
      missingFiles: 1,
      alreadyImported: false,
    };
    const { client, call } = fixture(preview);
    render(<WorkspaceBackup client={client} />);

    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("workspace.backup.export", {}));

    fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
    expect(await screen.findByText("2 recipes")).toBeInTheDocument();
    expect(screen.getByText("1 image file is missing. Its metadata will still be restored.")).toBeInTheDocument();
    expect(screen.getByText("1 duplicate recipe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore workspace" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("workspace.backup.restore", { stagingId: preview.stagingId }));
  });

  it("does not offer a second restore for a backup already merged into this workspace", async () => {
    const preview = {
      stagingId: "5edb9a4d-8a81-4b18-8c77-b676e5108d22",
      backupId: "b".repeat(64),
      createdAt: "2026-09-20T07:00:00.000Z",
      appVersion: "0.1.0",
      archiveBytes: 4096,
      counts,
      duplicates: emptyCounts,
      missingFiles: 0,
      alreadyImported: true,
    } satisfies WorkspaceBackupPreview;
    const { client, call } = fixture(preview);
    render(<WorkspaceBackup client={client} />);

    fireEvent.click(screen.getByRole("button", { name: "Review backup" }));
    const restoreButton = await screen.findByRole("button", { name: "Restore workspace" });
    expect(restoreButton).toBeDisabled();
    expect(screen.getByText("This backup has already been restored.")).toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith("workspace.backup.restore", expect.anything());
  });
});

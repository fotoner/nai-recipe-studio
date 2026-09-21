import { z } from "zod";

export type WorkspaceBackupCounts = {
  recipes: number;
  recipeVersions: number;
  characters: number;
  presets: number;
  galleryItems: number;
  images: number;
};

export type WorkspaceBackupPreview = {
  stagingId: string;
  backupId: string;
  createdAt: string;
  appVersion: string;
  archiveBytes: number;
  counts: WorkspaceBackupCounts;
  duplicates: WorkspaceBackupCounts;
  missingFiles: number;
  alreadyImported: boolean;
};

export type WorkspaceBackupRestoreResult = {
  restored: WorkspaceBackupCounts;
  skipped: WorkspaceBackupCounts;
  alreadyImported: boolean;
};

export interface WorkspaceBackupCommands {
  "workspace.backup.export": {
    input: Record<string, never>;
    output: { saved: boolean; counts?: WorkspaceBackupCounts; missingFiles?: number };
  };
  "workspace.backup.inspect": {
    input: { stagingId?: string };
    output: { preview: WorkspaceBackupPreview | null };
  };
  "workspace.backup.restore": {
    input: { stagingId: string };
    output: WorkspaceBackupRestoreResult;
  };
}

const empty = z.object({}).strict();
export const workspaceBackupInputSchemas = {
  "workspace.backup.export": empty,
  "workspace.backup.inspect": z.object({ stagingId: z.string().uuid().optional() }).strict(),
  "workspace.backup.restore": z.object({ stagingId: z.string().uuid() }).strict(),
} satisfies { [K in keyof WorkspaceBackupCommands]: z.ZodType<WorkspaceBackupCommands[K]["input"]> };

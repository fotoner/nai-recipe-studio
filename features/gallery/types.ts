import type { GalleryItem as StoredGalleryItem, Composed } from "@/contracts/studio";
export type GalleryItem = StoredGalleryItem & { recipe_snapshot: string; characters: Composed["characters"]; anlas_cost: number };
export type GalleryQuery = { rating_max?: number; recipe_id?: number; character_ids?: number[]; preset_ids?: number[]; limit?: number; offset?: number; sort?: "newest" | "oldest" };

import type { StoredPreset } from "@/contracts/studio";
import { i18n } from "./index";
import en from "./builtins/en.json";
import ko from "./builtins/ko.json";
import ja from "./builtins/ja.json";
for (const [language, resource] of Object.entries({ en, ko, ja })) i18n.addResourceBundle(language, "builtins", resource, true, true);

/** Only bundled labels are translated. Saved user content and prompt tags stay intact. */
export function presetName(preset: Pick<StoredPreset, "name"> & { builtinId?: string }): string {
  return preset.builtinId ? i18n.t(`${preset.builtinId}.name`, { ns: "builtins", defaultValue: preset.name }) : preset.name;
}
export function presetNotes(preset: Pick<StoredPreset, "notes"> & { builtinId?: string }): string {
  return preset.builtinId ? i18n.t(`${preset.builtinId}.notes`, { ns: "builtins", defaultValue: preset.notes }) : preset.notes;
}

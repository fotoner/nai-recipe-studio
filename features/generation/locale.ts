import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

for (const [language, resource] of Object.entries({ en, ja, ko })) {
  i18n.addResourceBundle(language, "generationView", resource, true, true);
}

export function useGenerationTranslation() {
  return useTranslation("generationView");
}

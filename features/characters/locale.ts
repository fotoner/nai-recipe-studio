import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import en from "./locales/en.json";
import ko from "./locales/ko.json";
import ja from "./locales/ja.json";

for (const [language, resource] of Object.entries({ en, ko, ja })) {
  i18n.addResourceBundle(language, "charactersView", resource, true, true);
}

export function useCharactersTranslation() {
  return useTranslation("charactersView");
}

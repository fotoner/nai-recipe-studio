import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import en from "./proposals-locales/en.json";
import ko from "./proposals-locales/ko.json";
import ja from "./proposals-locales/ja.json";

for (const [language, resource] of Object.entries({ en, ko, ja })) {
  i18n.addResourceBundle(language, "recipeProposals", resource, true, true);
}

export function useRecipeProposalsTranslation() {
  return useTranslation("recipeProposals");
}

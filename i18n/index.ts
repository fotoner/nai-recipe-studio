import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ko from "./locales/ko.json";
import ja from "./locales/ja.json";
import type { Language } from "@/features/shared/types";

export const supportedLanguages = ["ko", "ja", "en"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];
export const languageOptions: { value: Language; labelKey: string }[] = [
  { value: "system", labelKey: "settings.system" },
  { value: "ko", labelKey: "settings.korean" },
  { value: "ja", labelKey: "settings.japanese" },
  { value: "en", labelKey: "settings.english" },
];

export function normalizeLanguage(value?: string | null): SupportedLanguage {
  const lower = (value ?? "").toLowerCase();
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("ja")) return "ja";
  return "en";
}

export function resolveLanguage(preference: Language, systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language): SupportedLanguage {
  return preference === "system" ? normalizeLanguage(systemLanguage) : preference;
}

export const i18n: I18nInstance = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ko: { translation: ko }, ja: { translation: ja } },
  lng: resolveLanguage("system"),
  fallbackLng: "en",
  supportedLngs: supportedLanguages,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export async function changeLanguage(preference: Language, systemLanguage?: string): Promise<SupportedLanguage> {
  const resolved = resolveLanguage(preference, systemLanguage);
  await i18n.changeLanguage(resolved);
  if (typeof document !== "undefined") document.documentElement.lang = resolved;
  return resolved;
}

export function languagePreferenceFrom(value: unknown): Language {
  return value === "ko" || value === "ja" || value === "en" || value === "system" ? value : "system";
}

export type LanguageController = { i18n: I18nInstance; changeLanguage: typeof changeLanguage };

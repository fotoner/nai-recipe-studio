import en from "./locales/en.json";
import ko from "./locales/ko.json";
import ja from "./locales/ja.json";
export function nativeText(preference: string) {
  const language = preference === "system" ? Intl.DateTimeFormat().resolvedOptions().locale : preference;
  return language.toLowerCase().startsWith("ko") ? ko : language.toLowerCase().startsWith("ja") ? ja : en;
}

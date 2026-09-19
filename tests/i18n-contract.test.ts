/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import builtinEn from "../i18n/builtins/en.json";
import builtinKo from "../i18n/builtins/ko.json";
import builtinJa from "../i18n/builtins/ja.json";
import en from "../i18n/locales/en.json";
import ko from "../i18n/locales/ko.json";
import ja from "../i18n/locales/ja.json";
import { normalizeLanguage, resolveLanguage } from "../i18n";

function flatten(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return typeof item === "string" ? [[name, item]] : Object.entries(flatten(item as Record<string, unknown>, name));
  }));
}

describe("bundled language resources", () => {
  const featureResources = import.meta.glob(["../features/*/locales/*.json", "../desktop/main/locales/*.json"], { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
  const english = flatten(en);
  for (const [locale, source] of Object.entries({ ko, ja })) {
    it(`${locale} has every English key and the same interpolation fields`, () => {
      const translation = flatten(source);
      expect(Object.keys(translation).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(english)) {
        expect(translation[key].trim(), key).not.toBe("");
        const placeholders = (text: string) => [...text.matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort();
        expect(placeholders(translation[key]), key).toEqual(placeholders(value));
      }
    });
  }

  it("feature resources have all three languages and matching interpolation fields", () => {
    for (const [file, source] of Object.entries(featureResources).filter(([file]) => file.endsWith("/en.json"))) {
      const english = flatten(source);
      for (const language of ["ko", "ja"]) {
        const resource = featureResources[file.replace("/en.json", `/${language}.json`)];
        expect(resource, file).toBeDefined();
        const translated = flatten(resource);
        expect(Object.keys(translated).sort(), file).toEqual(Object.keys(english).sort());
        for (const [key, value] of Object.entries(english)) {
          expect(translated[key].trim(), `${file}:${key}`).not.toBe("");
          const slots = (text: string) => [...text.matchAll(/{{\s*([^}]+)\s*}}/g)].map(match => match[1].trim()).sort();
          expect(slots(translated[key]), `${file}:${key}`).toEqual(slots(value));
        }
      }
    }
  });

  it("ships a translated name for each neutral palette entry", () => {
    const english = flatten(builtinEn);
    for (const resource of [builtinKo, builtinJa]) {
      const translated = flatten(resource);
      expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
      for (const value of Object.values(translated)) expect(value.trim()).not.toBe("");
    }
  });

  it("normalizes OS locales and honors an explicit preference", () => {
    expect(normalizeLanguage("ko-KR")).toBe("ko");
    expect(normalizeLanguage("ja-JP")).toBe("ja");
    expect(resolveLanguage("system", "fr-FR")).toBe("en");
    expect(resolveLanguage("en", "ko-KR")).toBe("en");
  });
});

import * as React from "react";
import { BookOpen, Users, FlaskConical, Images, LayoutTemplate, Settings2, Sparkles } from "lucide-react";
import type { StudioClient } from "@/contracts/studio";
import { I18nextProvider, useTranslation } from "react-i18next";
import { changeLanguage, i18n, languagePreferenceFrom } from "@/i18n";
import { errorMessage, getStudioClient, subscribeToStudio, studioCall } from "@/desktop/renderer/studio-client";
import { parseRoute, routeHash, type Recipe, type StudioEvent, type ViewRoute } from "@/features/shared/types";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { AccountUsage } from "./AccountUsage";
import { RecipesFeature } from "@/features/recipes/RecipesFeature";
import { RecipeEditorFeature } from "@/features/recipe-editor/RecipeEditorFeature";
import { GenerationFeature } from "@/features/generation/GenerationFeature";
import { GalleryFeature } from "@/features/gallery/GalleryFeature";
import { PaletteFeature } from "@/features/palette/PaletteFeature";
import { CharactersFeature } from "@/features/characters/CharactersFeature";
import { SettingsFeature } from "@/features/settings/SettingsFeature";

export type RendererAppProps = { client?: StudioClient };

const navItems = [
  { page: "gallery", icon: Images, label: "nav.gallery" },
  { page: "recipes", icon: BookOpen, label: "nav.recipes" },
  { page: "palette", icon: LayoutTemplate, label: "nav.palette" },
  { page: "generation", icon: Sparkles, label: "nav.generation" },
  { page: "characters", icon: Users, label: "nav.characters" },
] as const;

export function RendererApp({ client = getStudioClient() }: RendererAppProps) {
  return <I18nextProvider i18n={i18n}><AppShell client={client} /></I18nextProvider>;
}

function AppShell({ client }: RendererAppProps) {
  const { t } = useTranslation();
  const [route, setRoute] = React.useState<ViewRoute>(() => parseRoute(typeof window === "undefined" ? "" : window.location.hash));
  const [blurSensitive, setBlurSensitive] = React.useState(false);
  const [connected, setConnected] = React.useState(false);

  const [generationRecipe, setGenerationRecipe] = React.useState<Recipe | undefined>();
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const acceptedHashRef = React.useRef(typeof window === "undefined" ? "" : window.location.hash);
  const recipeDirtyRef = React.useRef(false);
  const allowHashChangeRef = React.useRef(false);
  const restoringHashRef = React.useRef(false);

  const confirmDiscard = React.useCallback(() => window.confirm(`${t("editor.leaveTitle")}\n\n${t("editor.leaveDescription")}`), [t]);
  const setRecipeDirty = React.useCallback((dirty: boolean) => { recipeDirtyRef.current = dirty; }, []);

  React.useEffect(() => {
    const onHash = () => {
      if (restoringHashRef.current) {
        restoringHashRef.current = false;
        return;
      }
      const nextHash = window.location.hash;
      if (nextHash === acceptedHashRef.current) return;
      const next = parseRoute(nextHash);
      if (allowHashChangeRef.current) {
        allowHashChangeRef.current = false;
        recipeDirtyRef.current = false;
        acceptedHashRef.current = nextHash;
        setRoute(next);
        return;
      }
      if (recipeDirtyRef.current && !confirmDiscard()) {
        restoringHashRef.current = true;
        window.location.hash = acceptedHashRef.current;
        return;
      }
      recipeDirtyRef.current = false;
      acceptedHashRef.current = nextHash;
      setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [confirmDiscard]);
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!recipeDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  React.useEffect(() => {
    if (!client) return;
    let active = true;
    void Promise.all([studioCall(client, "settings.get", {}), studioCall(client, "status.read", {})]).then(async ([settings, status]) => {
      if (!active) return;
      setBlurSensitive(settings.blurSensitive); setConnected(status.connected); await changeLanguage(languagePreferenceFrom(settings.language));
    }).catch((cause) => { if (active) setFatalError(errorMessage(cause, "errors.load")); });
    const unsubscribe = subscribeToStudio(client, (event: StudioEvent) => {
      if (event.type === "settings.changed") { setBlurSensitive(event.settings.blurSensitive); void changeLanguage(event.settings.language); }
    });
    return () => { active = false; unsubscribe(); };
  }, [client]);

  const navigate = (next: ViewRoute, options?: { carryDraft?: boolean }) => {
    const nextHash = routeHash(next);
    if (window.location.hash === nextHash) return;
    if (options?.carryDraft || !recipeDirtyRef.current || confirmDiscard()) {
      recipeDirtyRef.current = false;
      allowHashChangeRef.current = true;
      window.location.hash = nextHash;
    }
  };
  const openGeneration = async (recipe?: Recipe) => {
    if (recipe && recipeDirtyRef.current) {
      if (!client) { setFatalError("errors.save"); return; }
      try {
        const expectedVersion = typeof recipe.version === "number" ? recipe.version : undefined;
        const saved = await studioCall(client, "recipes.save", { recipe, expectedVersion });
        setGenerationRecipe(saved);
        recipeDirtyRef.current = false;
        setFatalError(null);
        navigate({ page: "generation" }, { carryDraft: true });
      } catch (cause) {
        setFatalError(errorMessage(cause, "errors.save"));
      }
      return;
    }
    setGenerationRecipe(recipe);
    setFatalError(null);
    navigate({ page: "generation" });
  };
  const page = route.page === "recipes" ? <RecipesFeature client={client} onOpenRecipe={(id) => navigate({ page: "recipe", id })} onOpenGeneration={openGeneration} />
    : route.page === "recipe" ? <RecipeEditorFeature client={client} recipeId={route.id} onBack={() => navigate({ page: "recipes" })} onGenerate={openGeneration} onDirtyChange={setRecipeDirty} />
    : route.page === "generation" ? <GenerationFeature client={client} initialRecipe={generationRecipe} onOpenGallery={() => navigate({ page: "gallery" })} />
    : route.page === "gallery" ? <GalleryFeature key={window.location.hash} client={client} blurSensitive={blurSensitive} onOpenRecipe={(id) => navigate({ page: "recipe", id })} />
    : route.page === "palette" ? <PaletteFeature client={client} />
    : route.page === "characters" ? <CharactersFeature client={client} />
    : <SettingsFeature client={client} />;

  return <div className="flex min-h-svh flex-col md:flex-row">
    <aside className="flex shrink-0 flex-col border-b border-border md:h-svh md:w-52 md:border-r md:border-b-0">
      <a href="#/gallery" className="flex items-center gap-2 px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring"><FlaskConical className="size-4 text-primary" /><span className="text-sm font-semibold tracking-tight">{t("app.name")}</span></a>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:px-2" aria-label={t("aria.openMenu")}>
        {[...navItems, { page: "settings" as const, icon: Settings2, label: "nav.settings" }].map(({ page: pageName, icon: Icon, label }) => <button type="button" key={pageName} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors", route.page === pageName || (pageName === "recipes" && route.page === "recipe") ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")} onClick={() => navigate({ page: pageName } as ViewRoute)}><Icon className="size-4" />{t(label)}</button>)}
      </nav>
      <div className="mt-auto border-t border-border p-3 md:pb-12">
        <AccountUsage client={client} connected={connected} />
        <div className="flex items-center justify-between gap-2 text-xs"><label htmlFor="studio-nsfw-blur" className="cursor-pointer">{t("settings.blur")}</label><Switch id="studio-nsfw-blur" size="sm" checked={blurSensitive} onCheckedChange={value => { setBlurSensitive(value); if (client) void studioCall(client, "settings.update", { blurSensitive: value }).catch(() => setBlurSensitive(!value)); }} /></div>
        <p className="mt-1 text-[10px] text-muted-foreground">{t("settings.blurGlobal")}</p>
      </div>
    </aside>
    <main className="min-w-0 flex-1 md:h-svh md:overflow-y-auto">{fatalError ? <p role="alert" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">{t(fatalError.startsWith("errors.") ? fatalError : "errors.unknown")}</p> : null}{page}</main>
  </div>;
}

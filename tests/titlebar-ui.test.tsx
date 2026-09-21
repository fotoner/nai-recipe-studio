import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StudioClient } from "../contracts/studio";
import { RendererApp } from "../features/app/AppShell";

const previousStudio = Object.getOwnPropertyDescriptor(window, "studio");

function setMacOS(isMacOS: boolean) {
  Object.defineProperty(window, "studio", { configurable: true, value: { isMacOS } });
}

function createClient(): StudioClient {
  return {
    call: vi.fn(async (command: string) => {
      if (command === "settings.get") return { language: "en", blurSensitive: false, outputDirectory: "/tmp/output" };
      if (command === "status.read") return { appVersion: "0.1.0", schemaVersion: 1, connected: false, account: null, dryRun: true, locale: "en" };
      if (["gallery.list", "recipes.list", "characters.list", "presets.list"].includes(command)) return { items: [], total: 0 };
      return {};
    }),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as StudioClient;
}

afterEach(() => {
  if (previousStudio) Object.defineProperty(window, "studio", previousStudio);
  else Reflect.deleteProperty(window, "studio");
  window.location.hash = "";
});

describe("integrated macOS app chrome", () => {
  it("reserves native controls, keeps the app brand visible, and keeps the 208px sidebar", () => {
    setMacOS(true);
    render(<RendererApp client={createClient()} />);

    expect(screen.getByTestId("mac-titlebar-drag-region")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("NAI Recipe Studio")).not.toHaveClass("sr-only");
    expect(screen.getByRole("complementary")).toHaveClass("md:w-52");
  });

  it("keeps the existing visible app brand and standard title bar off macOS", () => {
    setMacOS(false);
    render(<RendererApp client={createClient()} />);

    expect(screen.queryByTestId("mac-titlebar-drag-region")).not.toBeInTheDocument();
    expect(screen.getByText("NAI Recipe Studio")).not.toHaveClass("sr-only");
    expect(screen.getByRole("complementary")).toHaveClass("md:w-52");
  });
});

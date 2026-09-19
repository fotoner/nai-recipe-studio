import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n";
import { LintSheet, type RecipeLintRow } from "../features/recipes/LintSheet";
import { newRecipe } from "../features/shared/types";

function row(id: number, name: string, findings: RecipeLintRow["findings"]): RecipeLintRow {
  return { recipe: { ...newRecipe(name), id, version: 1 }, findings };
}

afterEach(async () => {
  await changeLanguage("en");
});

describe("recipe lint sheet", () => {
  it("groups translated findings, hides passing recipes, and sends selected fixes by recipe", async () => {
    await changeLanguage("en");
    const onFix = vi.fn(async () => undefined);
    const rows = [
      row(9, "Sample recipe", [{ code: "PROMPT_SYNTAX", messageKey: "validation.promptSyntax", severity: "error", fixable: true, block: "scene" }]),
      row(10, "Passing recipe", []),
    ];

    render(<LintSheet open onOpenChange={vi.fn()} rows={rows} busy={false} onRerun={vi.fn()} onFix={onFix} />);

    expect(screen.getByRole("heading", { name: /Recipe check results/ })).toBeInTheDocument();
    expect(screen.getByText("A prompt tag uses syntax that needs normalization.")).toBeInTheDocument();
    expect(screen.getByText("Sample recipe")).toBeInTheDocument();
    expect(screen.queryByText("Passing recipe")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("Passing recipe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected fixes" }));

    await waitFor(() => expect(onFix).toHaveBeenCalledWith([{ recipe_id: 9, rules: ["PROMPT_SYNTAX"] }]));
  });

  it("forwards the rerun action without touching recipe data", async () => {
    const onRerun = vi.fn();
    render(<LintSheet open onOpenChange={vi.fn()} rows={[]} busy={false} onRerun={onRerun} onFix={vi.fn(async () => undefined)} />);

    fireEvent.click(screen.getByRole("button", { name: "Run check again" }));
    expect(onRerun).toHaveBeenCalledOnce();
  });
});

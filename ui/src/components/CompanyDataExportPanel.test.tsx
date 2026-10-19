// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyDataExportPanel } from "./CompanyDataExportPanel";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompanyDataExportPanel companyId={COMPANY_ID} />
      </TooltipProvider>,
    );
  });
  return container;
}

function byTestId(id: string): HTMLElement {
  const element = container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CompanyDataExportPanel", () => {
  it("links to a whole-window export of every record kind by default", () => {
    render();
    expect(byTestId("company-data-export-download").getAttribute("href")).toBe(
      `/api/companies/${COMPANY_ID}/archive/export?follow=true&include=run%2Cevents%2Ctranscript%2Ccosts%2Cactivity`,
    );
  });

  it("drops an unchecked kind and disables the download when nothing is left", () => {
    render();
    act(() => byTestId("company-data-export-include-transcript").click());
    expect(byTestId("company-data-export-download").getAttribute("href")).toContain(
      "include=run%2Cevents%2Ccosts%2Cactivity",
    );
    for (const kind of ["run", "events", "costs", "activity"]) {
      act(() => byTestId(`company-data-export-include-${kind}`).click());
    }
    const button = byTestId("company-data-export-download");
    expect(button.tagName).toBe("BUTTON");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(container!.textContent).toContain("Choose at least one kind of record.");
  });
});

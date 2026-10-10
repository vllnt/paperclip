// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RoutineListFilterBar,
  changeSearchParams,
  hasActiveRoutineFilters,
  readRoutineUrlFilters,
  routineListQueryFromFilters,
  useRoutineSearchDraft,
} from "./RoutineListFilters";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_CEO = "22222222-2222-4222-8222-222222222222";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("routine URL filters", () => {
  it("reads known values and ignores unknown ones", () => {
    expect(readRoutineUrlFilters(new URLSearchParams(`q=%20weekly%20&status=paused&trigger=manual&agent=${AGENT_A}`))).toEqual({
      q: "weekly",
      status: "paused",
      trigger: "manual",
      agentId: AGENT_A,
    });
    expect(readRoutineUrlFilters(new URLSearchParams("status=sleeping&trigger=cron&agent="))).toEqual({
      q: "",
      status: null,
      trigger: null,
      agentId: null,
    });
  });

  it("ignores an agent that is not a UUID and cuts q to the API limit, so a hand-edited link still lists", () => {
    const filters = readRoutineUrlFilters(new URLSearchParams(`agent=agent-1&q=${"x".repeat(250)}`));
    expect(filters.agentId).toBeNull();
    expect(filters.q).toHaveLength(200);
  });

  it("builds the list query, and a fixed agent wins over the agent in the URL", () => {
    const filters = readRoutineUrlFilters(new URLSearchParams(`q=weekly&agent=${AGENT_A}`));
    expect(routineListQueryFromFilters(filters)).toEqual({ q: "weekly", assigneeAgentId: AGENT_A });
    expect(routineListQueryFromFilters(filters, AGENT_CEO)).toEqual({ q: "weekly", assigneeAgentId: AGENT_CEO });
    expect(routineListQueryFromFilters(readRoutineUrlFilters(new URLSearchParams("")))).toEqual({});
  });

  it("does not count the agent in the URL as active when the agent is fixed", () => {
    const filters = readRoutineUrlFilters(new URLSearchParams(`agent=${AGENT_A}`));
    expect(hasActiveRoutineFilters(filters)).toBe(true);
    expect(hasActiveRoutineFilters(filters, AGENT_CEO)).toBe(false);
  });
});

describe("RoutineListFilterBar", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("applies a chip value and closes the chip once it is picked", async () => {
    const onFilterChange = vi.fn();
    root = createRoot(container);
    act(() => {
      root!.render(
        <RoutineListFilterBar
          searchDraft=""
          onSearchDraftChange={() => {}}
          filters={readRoutineUrlFilters(new URLSearchParams(""))}
          onFilterChange={onFilterChange}
          onClear={() => {}}
          active={false}
        />,
      );
    });
    expect(container.querySelector('[aria-label="Filter by agent"]')).toBeNull();

    const statusChip = container.querySelector<HTMLButtonElement>('[aria-label="Filter by status"]')!;
    await act(async () => {
      statusChip.click();
    });
    const paused = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Paused");
    expect(paused).toBeTruthy();
    await act(async () => {
      paused!.click();
    });
    expect(onFilterChange).toHaveBeenCalledWith("status", "paused");
    expect([...document.body.querySelectorAll("button")].some((button) => button.textContent === "Paused")).toBe(false);
  });
});

describe("useRoutineSearchDraft and changeSearchParams", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function Harness() {
    const [draft, setDraft] = useRoutineSearchDraft(40);
    const [, setSearchParams] = useSearchParams();
    const location = useLocation();
    return (
      <div>
        <input aria-label="Search routines" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" onClick={() => changeSearchParams(setSearchParams, (params) => params.set("status", "paused"))}>
          paused
        </button>
        <button
          type="button"
          onClick={() => {
            // Two writes before React renders the first one, like a chip right after the search timer.
            changeSearchParams(setSearchParams, (params) => params.set("status", "paused"));
            changeSearchParams(setSearchParams, (params) => params.set("trigger", "api"));
          }}
        >
          two
        </button>
        <button type="button" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
          clear
        </button>
        <output data-testid="search">{location.search}</output>
      </div>
    );
  }

  function render(initialUrl: string) {
    window.history.replaceState(null, "", initialUrl);
    root = createRoot(container);
    act(() => {
      root!.render(
        <BrowserRouter>
          <Harness />
        </BrowserRouter>,
      );
    });
  }

  const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Search routines"]')!;
  const search = () => new URLSearchParams(container.querySelector("output")!.textContent ?? "");
  const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function wait(ms: number) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, ms));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    window.history.replaceState(null, "", "/");
  });

  it("keeps both of two writes made before a render", async () => {
    render("/routines?q=weekly");
    await act(async () => {
      button("two").click();
    });
    expect(search().get("q")).toBe("weekly");
    expect(search().get("status")).toBe("paused");
    expect(search().get("trigger")).toBe("api");
  });

  it("keeps a filter picked while the search text waits to be written", async () => {
    render("/routines");
    await type("weekly");
    await act(async () => {
      button("paused").click();
    });
    await wait(120);
    expect(search().get("q")).toBe("weekly");
    expect(search().get("status")).toBe("paused");
  });

  it("starts from q in the URL, and an outside change of q replaces the text", async () => {
    render("/routines?q=old&status=active");
    expect(input().value).toBe("old");
    await act(async () => {
      button("clear").click();
    });
    expect(input().value).toBe("");
    await type("  new  ");
    await wait(120);
    expect(search().get("q")).toBe("new");
    // Its own write does not replace what is in the box.
    expect(input().value).toBe("  new  ");
  });
});

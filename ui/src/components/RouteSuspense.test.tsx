// @vitest-environment jsdom
import { act, lazy, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouteSuspense } from "./RouteSuspense";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RouteSuspense", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows the loader while a lazy page loads, then the page", async () => {
    const pending = deferred<{ default: ComponentType }>();
    const Page = lazy(() => pending.promise);

    await act(async () => {
      root.render(
        <RouteSuspense>
          <Page />
        </RouteSuspense>,
      );
    });
    expect(host.querySelector("[role=status]")).not.toBeNull();

    await act(async () => {
      pending.resolve({ default: () => <p>the page</p> });
      await pending.promise;
    });

    expect(host.querySelector("[role=status]")).toBeNull();
    expect(host.textContent).toContain("the page");
  });

  it("renders children at once when nothing suspends", async () => {
    await act(async () => {
      root.render(
        <RouteSuspense>
          <p>ready</p>
        </RouteSuspense>,
      );
    });

    expect(host.querySelector("[role=status]")).toBeNull();
    expect(host.textContent).toContain("ready");
  });
});

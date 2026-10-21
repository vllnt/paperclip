import { useCallback, useEffect, useState, type RefObject } from "react";

// Incremental rendering (PAP-13784, same pattern as IssuesList): an uncapped
// list is slow to paint and scroll when every row mounts up front. Render a
// bounded window and grow it as the scroll position nears the bottom.
const INITIAL_ROW_RENDER_LIMIT = 50;
const ROW_RENDER_BATCH_SIZE = 100;
const SCROLL_LOAD_THRESHOLD_PX = 480;

function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * The number of rows a long list may mount. It only ratchets up while the user
 * scrolls (a reset mid-scroll would yank rows out from under them) and returns
 * to the initial window when `resetKey` changes.
 *
 * @param rootRef - An element inside the scrolling container.
 * @param rowCount - How many rows the list would show without a budget.
 * @param resetKey - A value whose change restarts the budget, such as the company.
 * @returns The current row budget.
 */
export function useScrollRowBudget(
  rootRef: RefObject<HTMLElement | null>,
  rowCount: number,
  resetKey: unknown,
): number {
  const [limit, setLimit] = useState(INITIAL_ROW_RENDER_LIMIT);
  const hasMoreRows = rowCount > limit;

  useEffect(() => {
    setLimit(INITIAL_ROW_RENDER_LIMIT);
  }, [resetKey]);

  const loadMoreRows = useCallback(() => {
    setLimit((current) => current + ROW_RENDER_BATCH_SIZE);
  }, []);

  useEffect(() => {
    if (!hasMoreRows) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight = scrollContainer?.scrollHeight ?? document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        if (scrollBottom >= scrollHeight - SCROLL_LOAD_THRESHOLD_PX) {
          loadMoreRows();
        }
      });
    };

    scrollTarget.addEventListener("scroll", checkScrollPosition, { passive: true });
    window.addEventListener("resize", checkScrollPosition);
    // Initial check: a tall viewport (or an opened curtain) may need more rows
    // than the current budget before any scrolling happens.
    checkScrollPosition();

    return () => {
      scrollTarget.removeEventListener("scroll", checkScrollPosition);
      window.removeEventListener("resize", checkScrollPosition);
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [hasMoreRows, limit, loadMoreRows, rootRef]);

  return limit;
}

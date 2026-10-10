/**
 * Media-query reads that cannot throw. Some embedded webviews expose
 * `window.matchMedia` but throw when it is called, and a raw call in a render
 * or an effect then stops the whole app from rendering. Every media-query read
 * in the UI goes through here (`no-direct-match-media.test.ts` enforces it),
 * and each caller says what to assume when the browser cannot answer.
 */

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

/** Whether `query` matches now, or `fallback` when the browser cannot answer. */
export function matchesMedia(query: string, fallback: boolean): boolean {
  try {
    return mediaQueryList(query)?.matches ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Calls `onChange` with the new match state whenever `query` changes, and
 * returns the unsubscribe. Uses `addEventListener`, or `addListener` on older
 * query lists. It does nothing, and its unsubscribe does nothing, when the
 * browser cannot answer or when subscribing or unsubscribing throws.
 */
export function subscribeToMedia(query: string, onChange: (matches: boolean) => void): () => void {
  const list = mediaQueryList(query);
  if (!list) return () => undefined;
  const handleChange = (event: MediaQueryListEvent): void => onChange(event.matches);
  const modern = typeof list.addEventListener === "function";
  try {
    if (modern) list.addEventListener("change", handleChange);
    else list.addListener(handleChange);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (modern) list.removeEventListener("change", handleChange);
      else list.removeListener(handleChange);
    } catch {
      return;
    }
  };
}

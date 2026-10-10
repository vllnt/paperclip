import { useEffect, useState } from "react";
import { matchesMedia, subscribeToMedia } from "../lib/safe-match-media";

/**
 * Whether `query` matches, kept current as it changes. `fallback` is what to
 * render when the browser cannot answer (no `matchMedia`, or it throws).
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() => matchesMedia(query, fallback));

  useEffect(() => {
    setMatches(matchesMedia(query, fallback));
    return subscribeToMedia(query, setMatches);
  }, [query, fallback]);

  return matches;
}

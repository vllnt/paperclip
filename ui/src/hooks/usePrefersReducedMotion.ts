import { useMediaQuery } from "./useMediaQuery";

const QUERY = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(QUERY, false);
}

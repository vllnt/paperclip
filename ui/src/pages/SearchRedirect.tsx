import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "@/lib/router";
import { useOpenCommandPalette } from "../context/CommandActionsContext";
import { searchQueryFromUrlParams } from "../lib/search-query-parser";

/**
 * The command launcher replaced the search page. Old `/search?...` links land
 * on the dashboard with the launcher open, its text filled from the link's
 * query, filters, scope and sort.
 */
export function SearchRedirect() {
  const location = useLocation();
  const openCommandPalette = useOpenCommandPalette();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    openCommandPalette?.(searchQueryFromUrlParams(new URLSearchParams(location.search)));
  }, [location.search, openCommandPalette]);
  return <Navigate to="/dashboard" replace />;
}

import { useEffect, useRef } from "react";
import { useSearchParams } from "@/lib/router";

const NEW_ROUTINE_PARAM = "new";
const NEW_ROUTINE_PROJECT_PARAM = "projectId";

/**
 * A Routines page link that opens the New routine composer with a project already chosen.
 * @param projectId The project the new routine belongs to.
 * @returns The `/routines` href; `useNewRoutineLink` on that page reads it.
 * @example newRoutineHref(project.id) // "/routines?new=1&projectId=…"
 */
export function newRoutineHref(projectId: string): string {
  const params = new URLSearchParams({ [NEW_ROUTINE_PARAM]: "1", [NEW_ROUTINE_PROJECT_PARAM]: projectId });
  return `/routines?${params.toString()}`;
}

/**
 * Opens the New routine composer once when the URL is a `newRoutineHref` link, then drops the link's
 * parameters so a reload or Back does not open it again.
 * @param open Called with the requested project id, or null when the link names no project.
 * @param enabled Off for an embedded routine list, which does not own the page URL.
 */
export function useNewRoutineLink(open: (projectId: string | null) => void, enabled = true): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const openRef = useRef(open);
  openRef.current = open;
  const requested = enabled && searchParams.get(NEW_ROUTINE_PARAM) === "1";
  const projectId = searchParams.get(NEW_ROUTINE_PROJECT_PARAM);

  useEffect(() => {
    if (!requested) return;
    openRef.current(projectId || null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(NEW_ROUTINE_PARAM);
      next.delete(NEW_ROUTINE_PROJECT_PARAM);
      return next;
    }, { replace: true });
  }, [requested, projectId, setSearchParams]);
}

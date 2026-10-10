import { Suspense, type ReactNode } from "react";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

/**
 * Suspense boundary for lazy routes inside a layout. The layout, sidebar and
 * header stay mounted while a route chunk loads, so only the page area shows
 * the loader.
 */
export function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PaperclipLoading className="min-h-0 py-24" />}>{children}</Suspense>;
}

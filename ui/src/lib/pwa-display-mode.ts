import { matchesMedia } from "./safe-match-media";

export const CHROMELESS_DISPLAY_MODES = ["standalone", "fullscreen", "window-controls-overlay"] as const;

type DisplayMode = (typeof CHROMELESS_DISPLAY_MODES)[number];
type MatchDisplayMode = (query: string) => Pick<MediaQueryList, "matches">;

function displayModeQuery(mode: DisplayMode) {
  return `(display-mode: ${mode})`;
}

/** Reads the browser's display mode; a browser that cannot answer is a normal launch. */
const matchBrowserDisplayMode: MatchDisplayMode = (query) => ({ matches: matchesMedia(query, false) });

export function isChromelessDisplayMode(
  matchDisplayMode: MatchDisplayMode = matchBrowserDisplayMode,
  iosStandalone: boolean | undefined =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { standalone?: boolean }).standalone,
) {
  if (iosStandalone === true) return true;

  return CHROMELESS_DISPLAY_MODES.some((mode) => matchDisplayMode(displayModeQuery(mode)).matches);
}

import { Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenCommandPalette } from "../context/CommandActionsContext";
import { currentCommandLauncherKeyHint } from "../lib/keyboardShortcuts";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";

/**
 * The sidebar's search row: a button that opens the command launcher, with
 * its key hint. On touch devices it is the way to open the launcher.
 */
export function SidebarSearchTrigger({ rail }: { rail: boolean }) {
  const openCommandPalette = useOpenCommandPalette();
  const keyHint = currentCommandLauncherKeyHint();
  const button = (
    <button
      type="button"
      data-sidebar-search-trigger
      onClick={() => openCommandPalette?.()}
      aria-label={rail ? `Search (${keyHint})` : undefined}
      aria-keyshortcuts={keyHint === "⌘K" ? "Meta+K" : "Control+K"}
      className={cn(
        "flex items-center gap-2.5 mx-2 rounded-lg border border-border px-2 py-1.5 pointer-coarse:py-1 text-left text-(length:--text-compact) font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        rail && "justify-center border-transparent",
      )}
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "min-w-0 flex-1 truncate"}>Search…</span>
      {rail ? null : (
        <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground">
          {keyHint}
        </kbd>
      )}
    </button>
  );
  if (!rail) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{`Search (${keyHint})`}</TooltipContent>
    </Tooltip>
  );
}

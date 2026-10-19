import {
  formatResourceCapacitySnapshot,
  type ResourceCapacityLevel,
  type ResourceCapacitySnapshot,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { brandChipBadge, type BrandChipColor } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

const LEVELS: Record<ResourceCapacityLevel, { color: BrandChipColor; glyph: string; label: string; title: string }> = {
  ok: { color: "green", glyph: "●", label: "OK", title: "Enough disk, memory and CPU headroom" },
  low: { color: "amber", glyph: "⚠", label: "Low", title: "At least one resource is running low" },
  critical: { color: "red", glyph: "✕", label: "Critical", title: "At least one resource is nearly exhausted" },
  unknown: { color: "gray", glyph: "◌", label: "Unknown", title: "No reading in the last 15 minutes" },
};

/** Level chip: glyph, word and color, so it never relies on color alone. */
export function ResourceCapacityLevelBadge({ level }: { level: ResourceCapacityLevel }) {
  const spec = LEVELS[level];
  return (
    <Badge variant="outline" className={cn(brandChipBadge[spec.color], "font-medium")} title={spec.title}>
      <span aria-hidden="true">{spec.glyph}</span>
      {spec.label}
    </Badge>
  );
}

/**
 * The level chip and one line of numbers, the same line the CLI prints.
 * Pass `unsupported` for drivers whose host is not measured.
 */
export function ResourceCapacitySummary({
  snapshot,
  unsupported = false,
  className,
}: {
  snapshot: ResourceCapacitySnapshot;
  unsupported?: boolean;
  className?: string;
}) {
  if (unsupported) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>
        Capacity is not measured for this driver.
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground", className)}>
      <ResourceCapacityLevelBadge level={snapshot.level} />
      <span>{formatResourceCapacitySnapshot(snapshot)}</span>
    </div>
  );
}

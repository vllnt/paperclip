import { useState } from "react";
import { COMPANY_ARCHIVE_INCLUDES, type CompanyArchiveInclude } from "@paperclipai/shared";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { companyArchiveApi } from "../api/companyArchive";
import { Field } from "./agent-config-primitives";

const INCLUDE_LABELS: Record<CompanyArchiveInclude, string> = {
  run: "Runs",
  events: "Run events",
  transcript: "Transcripts",
  costs: "Costs",
  activity: "Activity",
};

/** `YYYY-MM-DD` from a date input, as the start of that day in UTC. */
function sinceFromDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Board download of the company's run history (company archive format v1).
 * The same export is available as `GET /api/companies/:id/archive/export` and
 * `paperclipai archive export`.
 */
export function CompanyDataExportPanel({ companyId }: { companyId: string }) {
  const [since, setSince] = useState("");
  const [include, setInclude] = useState<CompanyArchiveInclude[]>([...COMPANY_ARCHIVE_INCLUDES]);
  const sinceDate = sinceFromDateInput(since);
  const sinceInvalid = since !== "" && sinceDate === null;
  const canDownload = include.length > 0 && !sinceInvalid;
  const href = companyArchiveApi.exportDownloadUrl(companyId, { since: sinceDate, include });

  function toggle(entity: CompanyArchiveInclude, checked: boolean) {
    setInclude((current) =>
      COMPANY_ARCHIVE_INCLUDES.filter((item) => (item === entity ? checked : current.includes(item))),
    );
  }

  return (
    <div className="max-w-2xl space-y-4" data-testid="company-settings-data-export-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Data export
      </div>
      <p className="text-sm text-muted-foreground">
        Download this organization's run history as NDJSON: finished runs, their events,
        transcripts, costs and activity. Records are redacted the same way as the run pages,
        and each download is recorded in the activity log.
      </p>
      <div className="space-y-3">
        <Field label="Runs finished since" hint="Leave empty to export the whole history.">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            type="date"
            value={since}
            aria-invalid={sinceInvalid}
            data-testid="company-data-export-since"
            onChange={(event) => setSince(event.target.value)}
          />
        </Field>
        <Field label="Include">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {COMPANY_ARCHIVE_INCLUDES.map((entity) => (
              <label key={entity} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={include.includes(entity)}
                  onCheckedChange={(value) => toggle(entity, value === true)}
                  data-testid={`company-data-export-include-${entity}`}
                />
                {INCLUDE_LABELS[entity]}
              </label>
            ))}
          </div>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {canDownload ? (
            <Button size="sm" variant="outline" asChild>
              <a href={href} download data-testid="company-data-export-download">
                <Download />
                Download export
              </a>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled data-testid="company-data-export-download">
              <Download />
              Download export
            </Button>
          )}
          {include.length === 0 && (
            <span className="text-xs text-destructive">Choose at least one kind of record.</span>
          )}
          {sinceInvalid && <span className="text-xs text-destructive">Enter a valid date.</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          For a large history, the CLI can continue an interrupted download:{" "}
          <code>paperclipai archive export --company-id {companyId} --out export.ndjson --resume</code>
        </p>
      </div>
    </div>
  );
}

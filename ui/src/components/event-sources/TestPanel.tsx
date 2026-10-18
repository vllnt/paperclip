import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  EVENT_SEVERITIES,
  EVENT_STATES,
  eventSourcesApi,
  type EventSource,
  type EventTestMatch,
  type EventTestResult,
} from "@/api/eventSources";
import { sampleTestPayload } from "@/lib/event-source-form";
import { TEST_ACTION_META, ToneBadge } from "./meta";

const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

type TestForm = {
  emitter: string;
  type: string;
  severity: string;
  state: string;
  dedupeKey: string;
  title: string;
  labelsText: string;
};

function initialForm(): TestForm {
  const sample = sampleTestPayload("generic_v1") as Record<string, unknown>;
  return {
    emitter: String(sample.source),
    type: String(sample.type),
    severity: String(sample.severity),
    state: String(sample.state),
    dedupeKey: String(sample.dedupeKey),
    title: String(sample.title),
    labelsText: Object.entries(sample.labels as Record<string, string>)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  };
}

function formToPayload(form: TestForm): Record<string, unknown> {
  const labels: Record<string, string> = {};
  for (const line of form.labelsText.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    labels[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    schema: "paperclip.event.v1",
    source: form.emitter.trim(),
    type: form.type.trim(),
    severity: form.severity,
    state: form.state,
    dedupeKey: form.dedupeKey.trim(),
    title: form.title.trim(),
    labels,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Dry run (design §3.7): sends a sample event through normalization, matching
 * and grouping, and shows what would happen. The server writes nothing.
 */
export function TestPanel({ source }: { source: EventSource }) {
  const ids = useId();
  const isGatus = source.normalizer === "gatus";
  const [mode, setMode] = useState<"form" | "json">(isGatus ? "json" : "form");
  const [form, setForm] = useState<TestForm>(initialForm);
  const [json, setJson] = useState(() =>
    JSON.stringify(sampleTestPayload(source.normalizer), null, 2),
  );
  const [parseError, setParseError] = useState("");
  const dryRun = useMutation({
    mutationFn: (payload: Record<string, unknown>) => eventSourcesApi.test(source.id, payload),
  });
  const patch = (values: Partial<TestForm>) => setForm((current) => ({ ...current, ...values }));

  function run() {
    setParseError("");
    if (mode === "form") {
      dryRun.mutate(formToPayload(form));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("The payload must be a single JSON object.");
        return;
      }
      dryRun.mutate(parsed as Record<string, unknown>);
    } catch {
      setParseError("The payload isn’t valid JSON.");
    }
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-4">
      <div className="space-y-1">
        <h2 id={`${ids}-title`} className="flex items-center gap-2 text-base font-semibold">
          <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Test an event
        </h2>
        <p className="text-sm text-muted-foreground">
          Runs the event through normalization, matching and grouping to show which routines it would
          reach. Nothing is saved, no issue is created and no agent is woken.
        </p>
      </div>

      <Tabs value={mode} onValueChange={(value) => setMode(value as "form" | "json")}>
        <TabsList>
          {!isGatus && <TabsTrigger value="form">Form</TabsTrigger>}
          <TabsTrigger value="json">{isGatus ? "Alert body" : "Raw JSON"}</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="space-y-4 pt-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${ids}-emitter`}>Emitter</Label>
              <Input
                id={`${ids}-emitter`}
                className="font-mono"
                value={form.emitter}
                onChange={(event) => patch({ emitter: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-type`}>Type</Label>
              <Input
                id={`${ids}-type`}
                className="font-mono"
                value={form.type}
                onChange={(event) => patch({ type: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-severity`}>Severity</Label>
              <select
                id={`${ids}-severity`}
                className={selectClass}
                value={form.severity}
                onChange={(event) => patch({ severity: event.target.value })}
              >
                {EVENT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-state`}>State</Label>
              <select
                id={`${ids}-state`}
                className={selectClass}
                value={form.state}
                onChange={(event) => patch({ state: event.target.value })}
              >
                {EVENT_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-dedupe`}>Dedupe key</Label>
            <Input
              id={`${ids}-dedupe`}
              className="font-mono"
              value={form.dedupeKey}
              onChange={(event) => patch({ dedupeKey: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Stable per alert. Events with the same key and group key share an issue.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-title-input`}>Title</Label>
            <Input
              id={`${ids}-title-input`}
              value={form.title}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-labels`}>Labels</Label>
            <Textarea
              id={`${ids}-labels`}
              rows={3}
              className="font-mono text-xs"
              value={form.labelsText}
              onChange={(event) => patch({ labelsText: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              One <code>key=value</code> per line. Pinned labels of this source are applied on top.
            </p>
          </div>
        </TabsContent>
        <TabsContent value="json" className="space-y-2 pt-2">
          <Label htmlFor={`${ids}-json`}>
            {isGatus ? "Body of a Gatus alert" : "Event payload"}
          </Label>
          <Textarea
            id={`${ids}-json`}
            rows={12}
            className="font-mono text-xs"
            value={json}
            aria-invalid={Boolean(parseError) || undefined}
            onChange={(event) => setJson(event.target.value)}
          />
          {isGatus && (
            <p className="text-xs text-muted-foreground">
              Paste the body your Gatus alert sends. The Gatus normalizer maps it to an event.
            </p>
          )}
        </TabsContent>
      </Tabs>

      {parseError && (
        <p role="alert" className="text-sm text-destructive">
          {parseError}
        </p>
      )}
      {dryRun.isError && (
        <p role="alert" className="text-sm text-destructive">
          {dryRun.error instanceof Error ? dryRun.error.message : "The dry run failed."}
        </p>
      )}
      <Button onClick={run} disabled={dryRun.isPending}>
        {dryRun.isPending ? "Running…" : "Run dry run"}
      </Button>

      {dryRun.data && <TestResult result={dryRun.data} />}
    </section>
  );
}

function TestResult({ result }: { result: EventTestResult }) {
  return (
    <div aria-label="Dry run result" role="region" className="space-y-5 rounded-md border border-border p-4">
      {result.errors.length > 0 && (
        <div role="alert" className="space-y-1">
          <p className="text-sm font-medium text-destructive">
            This payload would be rejected (422)
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {result.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      {result.event && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Normalized event</h3>
          <dl className="space-y-1 text-sm">
            {[
              ["Emitter", result.event.source],
              ["Type", result.event.type],
              ["Severity", result.event.severity],
              ["State", result.event.state],
              ["Dedupe key", result.event.dedupeKey],
              ["Title", result.event.title],
            ].map(([term, detail]) => (
              <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                <dt className="shrink-0 text-muted-foreground sm:w-28">{term}</dt>
                <dd className="min-w-0 break-words font-mono text-xs">{detail}</dd>
              </div>
            ))}
            {Object.keys(result.event.labels).length > 0 && (
              <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
                <dt className="shrink-0 text-muted-foreground sm:w-28">Labels</dt>
                <dd className="min-w-0 break-words font-mono text-xs">
                  {Object.entries(result.event.labels)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ")}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {result.outcome === "unrouted" && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md bg-muted/40 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--status-agent-paused)" aria-hidden="true" />
          <p>
            <strong className="font-medium">Unrouted.</strong> No routine matches this event and
            there is no fallback trigger, so in production nobody would be woken. The delivery would
            be recorded as unrouted.
          </p>
        </div>
      )}

      {result.matches.length > 0 && (
        <MatchList title="Matched triggers" matches={result.matches} />
      )}
      {result.fallbackMatches.length > 0 && (
        <MatchList
          title="Fallback triggers"
          hint="Only used when no routine above takes the event."
          matches={result.fallbackMatches}
        />
      )}
    </div>
  );
}

function MatchList({
  title,
  hint,
  matches,
}: {
  title: string;
  hint?: string;
  matches: EventTestMatch[];
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {matches.map((match) => {
          const action = TEST_ACTION_META[match.action];
          return (
            <li key={match.triggerId} className="space-y-1.5 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  to={`/routines/${match.routineId}/triggers`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {match.routineTitle}
                </Link>
                <ToneBadge tone={action?.tone ?? "muted"}>{action?.label ?? match.action}</ToneBadge>
              </div>
              <p className="text-xs text-muted-foreground">
                {match.assigneeAgentName
                  ? `Agent: ${match.assigneeAgentName}`
                  : match.assigneeAgentId
                    ? "Agent assigned"
                    : "No agent assigned"}
                {match.issueIdentifier && (
                  <>
                    {" · "}
                    <Link className="underline underline-offset-2" to={`/issues/${match.issueIdentifier}`}>
                      {match.issueIdentifier}
                    </Link>
                  </>
                )}
              </p>
              <p className="break-all font-mono text-xs">
                <span className="font-sans text-muted-foreground">Group key: </span>
                {match.groupKey}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

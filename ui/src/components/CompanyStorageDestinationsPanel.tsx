import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  STORAGE_ENCRYPTION_MODES,
  type CompanySecret,
  type StorageDestinationView,
  type StorageEncryptionMode,
  type StorageProbeResult,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { companyStorageApi } from "../api/companyStorage";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Field, ToggleField } from "./agent-config-primitives";

const ENCRYPTION_LABELS: Record<StorageEncryptionMode, string> = {
  s3_managed: "S3-managed keys (AES-256)",
  kms: "KMS key",
  bucket_default: "Bucket default (provider encrypts at rest)",
};

const inputClass = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function probeSummary(probe: StorageProbeResult): string {
  const summary = baseProbeSummary(probe);
  return probe.pending && probe.status !== "running" ? `${summary} A new probe is running.` : summary;
}

function baseProbeSummary(probe: StorageProbeResult): string {
  if (probe.status === "running") return "Probe running";
  if (probe.status === "failed") return probe.error ?? "Probe failed";
  const parts = [
    probe.encryption === "verified" ? "encryption verified" : "encryption not reported by the provider",
    "not publicly readable",
    probe.isolation === "prefix_scoped"
      ? "key limited to its prefix"
      : probe.isolation === "bucket_wide"
        ? "key can write outside its prefix"
        : null,
  ].filter(Boolean);
  return `Probe passed: ${parts.join(", ")}.`;
}

function SecretSelect({
  label,
  value,
  onChange,
  secrets,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secrets: CompanySecret[];
  testId: string;
}) {
  return (
    <Field label={label}>
      <select className={selectClass} value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId}>
        <option value="">Choose a company secret</option>
        {secrets.map((secret) => (
          <option key={secret.id} value={secret.id}>{secret.name}</option>
        ))}
      </select>
    </Field>
  );
}

function CreateDestinationForm({
  companyId,
  secrets,
  onDone,
}: {
  companyId: string;
  secrets: CompanySecret[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("https://");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("paperclip");
  const [pathStyle, setPathStyle] = useState(false);
  const [mode, setMode] = useState<StorageEncryptionMode>("s3_managed");
  const [kmsKeyId, setKmsKeyId] = useState("");
  const [accessKeySecretId, setAccessKeySecretId] = useState("");
  const [secretKeySecretId, setSecretKeySecretId] = useState("");
  // One id per form, so a retried submit cannot create a second destination.
  const [id] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () =>
      companyStorageApi.create(companyId, {
        id,
        label: label.trim(),
        location: {
          endpoint: endpoint.trim().endsWith("/") ? endpoint.trim() : `${endpoint.trim()}/`,
          region: region.trim(),
          bucket: bucket.trim(),
          prefix: prefix.trim(),
          forcePathStyle: pathStyle,
          encryption: mode === "kms" ? { mode, kmsKeyId: kmsKeyId.trim() } : { mode },
        },
        credentials: { accessKeySecretId, secretKeySecretId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.storageDestinations(companyId) });
      onDone();
    },
  });

  const complete = label.trim() && region.trim() && bucket.trim() && endpoint.trim().length > "https://".length
    && accessKeySecretId && secretKeySecretId && (mode !== "kms" || kmsKeyId.trim());

  return (
    <div className="space-y-3 rounded-md border border-border p-4" data-testid="storage-destination-form">
      <Field label="Name">
        <input className={inputClass} value={label} onChange={(event) => setLabel(event.target.value)} data-testid="storage-destination-label" />
      </Field>
      <Field label="Endpoint" hint="The S3 endpoint origin, for example https://s3.eu-west-1.amazonaws.com. HTTPS only.">
        <input className={inputClass} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} data-testid="storage-destination-endpoint" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Region">
          <input className={inputClass} value={region} onChange={(event) => setRegion(event.target.value)} data-testid="storage-destination-region" />
        </Field>
        <Field label="Bucket">
          <input className={inputClass} value={bucket} onChange={(event) => setBucket(event.target.value)} data-testid="storage-destination-bucket" />
        </Field>
      </div>
      <Field label="Prefix" hint="Paperclip writes under this prefix, plus one ownership marker, .paperclip/owner.json, at the bucket root.">
        <input className={inputClass} value={prefix} onChange={(event) => setPrefix(event.target.value)} data-testid="storage-destination-prefix" />
      </Field>
      <ToggleField label="Path-style addressing (MinIO and some S3-compatible services)" checked={pathStyle} onChange={setPathStyle} />
      <Field label="Server-side encryption">
        <select className={selectClass} value={mode} onChange={(event) => setMode(event.target.value as StorageEncryptionMode)} data-testid="storage-destination-encryption">
          {STORAGE_ENCRYPTION_MODES.map((option) => (
            <option key={option} value={option}>{ENCRYPTION_LABELS[option]}</option>
          ))}
        </select>
      </Field>
      {mode === "kms" && (
        <Field label="KMS key id">
          <input className={inputClass} value={kmsKeyId} onChange={(event) => setKmsKeyId(event.target.value)} />
        </Field>
      )}
      <SecretSelect label="Access key id secret" value={accessKeySecretId} onChange={setAccessKeySecretId} secrets={secrets} testId="storage-destination-access-secret" />
      <SecretSelect label="Secret access key secret" value={secretKeySecretId} onChange={setSecretKeySecretId} secrets={secrets} testId="storage-destination-secret-secret" />
      {secrets.length === 0 && (
        <p className="text-xs text-muted-foreground">Add the access key id and the secret key as company secrets first.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} disabled={create.isPending}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!complete || create.isPending} data-testid="storage-destination-save">
          {create.isPending ? "Saving..." : "Save destination"}
        </Button>
        {create.isError && (
          <span className="text-xs text-destructive" data-testid="storage-destination-save-error">
            {errorMessage(create.error, "Could not save the destination")}
          </span>
        )}
      </div>
    </div>
  );
}

function DestinationRow({ companyId, destination }: { companyId: string; destination: StorageDestinationView }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.storageDestinations(companyId) });
  const probe = useMutation({ mutationFn: () => companyStorageApi.probe(companyId, destination.id), onSettled: refresh });
  const retire = useMutation({
    mutationFn: () => companyStorageApi.retire(companyId, destination.id, destination.revision),
    onSettled: refresh,
  });
  const location = destination.location;
  const endpointHost = new URL(location.endpoint).host;
  const retired = destination.retiredAt !== null;
  const lastProbe = destination.lastProbe;

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid={`storage-destination-${destination.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{destination.label}</div>
          <div className="truncate text-xs text-muted-foreground">
            {endpointHost} / {location.bucket}{location.prefix ? ` / ${location.prefix}` : ""} · {ENCRYPTION_LABELS[location.encryption.mode]}
          </div>
        </div>
        {!retired && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending} data-testid="storage-destination-probe">
              {probe.isPending ? "Probing..." : "Probe"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={retire.isPending}
              data-testid="storage-destination-retire"
              onClick={() => {
                if (window.confirm(`Retire "${destination.label}"? It stops being used. Nothing is deleted.`)) retire.mutate();
              }}
            >
              Retire
            </Button>
          </div>
        )}
      </div>
      <p
        className={`text-xs ${lastProbe?.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        data-testid="storage-destination-status"
      >
        {retired ? "Retired. Kept for history; nothing is written to it." : lastProbe ? probeSummary(lastProbe) : "Not probed yet."}
      </p>
      {(probe.isError || retire.isError) && (
        <p className="text-xs text-destructive">{errorMessage(probe.error ?? retire.error, "The request failed")}</p>
      )}
    </div>
  );
}

/**
 * Company Settings: the organization's own S3-compatible buckets. The same
 * operations exist as `/api/companies/:id/storage/destinations` and
 * `paperclipai storage destinations`.
 */
export function CompanyStorageDestinationsPanel({ companyId }: { companyId: string }) {
  const [adding, setAdding] = useState(false);
  const destinations = useQuery({
    queryKey: queryKeys.storageDestinations(companyId),
    queryFn: () => companyStorageApi.list(companyId),
  });
  const secrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: adding,
  });
  const companySecrets = (secrets.data ?? []).filter((secret) => secret.scope === "company" && secret.status === "active");

  return (
    <div className="max-w-2xl space-y-4" data-testid="company-settings-storage-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Storage destinations</div>
      <p className="text-sm text-muted-foreground">
        Your organization's own S3-compatible buckets (AWS S3, Cloudflare R2, MinIO, OVH and others). Paperclip
        connects with keys stored as company secrets and never creates buckets, policies or lifecycle rules. Use a
        private bucket that no other organization uses. The first passing probe claims the bucket for this
        organization with an ownership marker; the claim stays after a destination is retired, because retiring
        deletes nothing.
      </p>
      {destinations.isLoading && <p className="text-xs text-muted-foreground">Loading destinations...</p>}
      {destinations.isError && (
        <p className="text-xs text-destructive">{errorMessage(destinations.error, "Could not load storage destinations")}</p>
      )}
      {destinations.data && destinations.data.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground" data-testid="storage-destinations-empty">No destinations yet.</p>
      )}
      <div className="space-y-2">
        {destinations.data?.map((destination) => (
          <DestinationRow key={destination.id} companyId={companyId} destination={destination} />
        ))}
      </div>
      {adding ? (
        <CreateDestinationForm companyId={companyId} secrets={companySecrets} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="storage-destination-add">
          Add destination
        </Button>
      )}
    </div>
  );
}

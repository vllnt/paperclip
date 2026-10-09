import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { ApiError } from "@/api/client";
import { resourceCapacityApi } from "@/api/resourceCapacity";
import { Card } from "@/components/ui/card";
import { ResourceCapacitySummary } from "@/components/ResourceCapacitySummary";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";

/** The server samples every minute; refresh at the same pace. */
const REFRESH_INTERVAL_MS = 60_000;

/** CPU, memory and disk of every server host and environment. Instance admins only. */
export function InstanceResourceCapacity() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Resource capacity" },
    ]);
  }, [setBreadcrumbs]);

  const capacityQuery = useQuery({
    queryKey: queryKeys.resourceCapacity.instance,
    queryFn: () => resourceCapacityApi.instance(),
    refetchInterval: REFRESH_INTERVAL_MS,
    retry: false,
  });

  if (capacityQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading resource capacity…</div>;
  }

  if (capacityQuery.error) {
    const message =
      capacityQuery.error instanceof ApiError && capacityQuery.error.status === 403
        ? "Instance admin access is required to view resource capacity."
        : capacityQuery.error instanceof Error
          ? capacityQuery.error.message
          : "Failed to load resource capacity.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  const hosts = capacityQuery.data?.hosts ?? [];
  const environments = capacityQuery.data?.environments ?? [];

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Resource capacity</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Free disk, available memory and load per CPU core of the servers running Paperclip and of every
          environment. Sampled every minute; a level is Unknown when nothing was measured in the last 15 minutes.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Server hosts</h2>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No host has reported yet.</p>
        ) : (
          <Card className="block divide-y divide-border p-0">
            {hosts.map((host) => (
              <div key={host.targetKey} className="space-y-1 px-4 py-3">
                <div className="text-sm font-medium">
                  {host.hostLabel ?? host.targetKey}
                  {host.current ? <span className="font-normal text-muted-foreground"> · this server</span> : null}
                </div>
                <ResourceCapacitySummary snapshot={host} />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Environments</h2>
        {environments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No environments.</p>
        ) : (
          <Card className="block divide-y divide-border p-0">
            {environments.map((environment) => (
              <div key={environment.environmentId} className="space-y-1 px-4 py-3">
                <div className="text-sm font-medium">
                  {environment.environmentName}
                  <span className="font-normal text-muted-foreground"> · {environment.driver}</span>
                </div>
                <ResourceCapacitySummary
                  snapshot={environment}
                  unsupported={environment.sampling === "unsupported"}
                />
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

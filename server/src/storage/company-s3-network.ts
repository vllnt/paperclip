import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { StorageS3Location } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  resolveApprovedRemoteHttpAddresses,
  type RemoteHttpEndpointGuardOptions,
} from "../services/remote-http-endpoint-guard.js";

// Adapted from the unmerged 2026-10-04 company S3 storage work: approve DNS
// answers inside the socket lookup itself, so no second resolution can rebind
// a company endpoint to a private or metadata address.

/** Exact origins (for example an in-cluster MinIO) the operator allows over http or private ranges. */
function privateOriginAllowlist(): string[] {
  return (process.env.PAPERCLIP_STORAGE_PRIVATE_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Company endpoints must be public HTTPS unless the operator allowlists the
 * exact origin. A company cannot edit the allowlist.
 */
export function storageEndpointPolicy(location: Pick<StorageS3Location, "endpoint">) {
  const endpoint = new URL(location.endpoint);
  const allowPrivateNetwork = privateOriginAllowlist().includes(endpoint.origin);
  if (endpoint.protocol !== "https:" && !allowPrivateNetwork) {
    throw unprocessable("Use an HTTPS endpoint. A private endpoint needs an operator allowlist entry.");
  }
  return { endpoint, allowPrivateNetwork };
}

/** Keeps the guard's reason code (for example `remote_http_dns_failed`) for callers. */
const endpointUnavailable = (_message?: string, code?: string) =>
  unprocessable("The storage endpoint is unavailable or outside the operator network policy", code ? { code } : undefined);

/** Host names the S3 client may connect to for this location. */
export function allowedStorageHosts(location: Pick<StorageS3Location, "endpoint" | "bucket" | "forcePathStyle">) {
  const hostname = new URL(location.endpoint).hostname;
  return location.forcePathStyle ? [hostname] : [hostname, `${location.bucket}.${hostname}`];
}

/**
 * Socket lookup for a company S3 client: it only resolves the destination's
 * own host names, and only to addresses the network policy approves.
 */
export async function companyS3Lookup(
  location: StorageS3Location,
  guard: Pick<RemoteHttpEndpointGuardOptions, "lookup" | "dnsTimeoutMs"> = {},
): Promise<LookupFunction> {
  const { endpoint, allowPrivateNetwork } = storageEndpointPolicy(location);
  const options = { ...guard, allowPrivateNetwork };
  // Node skips the lookup for IP literals, so check those here as well.
  await resolveApprovedRemoteHttpAddresses(endpoint, options, endpointUnavailable);
  const allowedHosts = allowedStorageHosts(location);
  return (hostname, lookupOptions, callback) => {
    if (!allowedHosts.includes(hostname)) {
      callback(endpointUnavailable(), "", 4);
      return;
    }
    const url = new URL(endpoint);
    url.hostname = hostname;
    void resolveApprovedRemoteHttpAddresses(url, options, endpointUnavailable).then((addresses) => {
      const entries = addresses.map((address) => ({ address, family: isIP(address) }));
      if (lookupOptions.all) callback(null, entries as never, undefined as never);
      else callback(null, entries[0]!.address, entries[0]!.family);
    }, () => callback(endpointUnavailable(), "", 4));
  };
}

/**
 * Request handler options for a company S3 client: fresh agents with the
 * guarded lookup. The SDK does not follow redirects.
 */
export async function companyS3RequestHandler(location: StorageS3Location) {
  const lookup = await companyS3Lookup(location);
  return {
    httpAgent: new http.Agent({ keepAlive: false, lookup }),
    httpsAgent: new https.Agent({ keepAlive: false, lookup }),
    connectionTimeout: 5_000,
    requestTimeout: 30_000,
    throwOnRequestTimeout: true,
  };
}

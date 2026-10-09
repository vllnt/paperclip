# Company Storage Destinations

A storage destination is an organization's own S3-compatible bucket (AWS S3,
Cloudflare R2, MinIO, OVH and others). It is the S3-01 part of the company S3
storage plan. The company archive uses it first; asset storage can use it
later.

Board users manage destinations in **Company Settings → Storage
destinations**, through `/api/companies/:companyId/storage/destinations`, or
with `paperclipai storage destinations` (see [CLI.md](CLI.md)). Creating a
destination, rotating its keys and retiring it need a company **owner or
admin** (the same rule as secret definitions), because they decide where
company keys are sent. Other board members can list and probe. Agents cannot
manage destinations. On cloud-managed instances every storage route answers
403, because the platform owns storage there.

## What a destination holds

| Field | Rule |
|---|---|
| Location | HTTPS endpoint origin, region, bucket, prefix, path-style flag, encryption mode. **Immutable**: a change is a new destination. |
| Credentials | Two company secrets: the access key id and the secret access key. They must be **dedicated**: a secret already bound to anything other than a storage destination is refused (`secret_in_use`), because S3 signing sends the access key id in clear to the endpoint. Their current versions are pinned when they are set, and two `company_secret_bindings` rows (target type `storage_destination`) record the use. There is no fallback to instance or ambient AWS credentials. |
| Revisions | `revision` changes on every update; `credentialRevision` on every key rotation. Rotate and retire take the expected revision and answer 409 when it is stale. |
| Last probe | The result of the latest probe (below). A key rotation clears it. |

Paperclip never creates buckets, bucket policies, ACLs or lifecycle rules, and
never deletes objects except its own probe objects. Retiring a destination
stops its use and deletes nothing.

## Rules

- **One bucket per organization on an instance.** The first organization
  whose probe passes for a bucket reserves it. After that, another
  organization cannot create a destination for the same endpoint host and
  bucket (any prefix), and an older unproven one fails its probe with
  `location_unavailable`. An unproven destination reserves nothing, so a
  bucket cannot be squatted with keys that do not work. The error does not say
  which organization uses it. Host names are compared after dropping a
  trailing dot, and every AWS S3 regional, dualstack and legacy host counts as
  one; other aliases of one service are not detected.
- **Use needs a current probe.** Consumers (the company archive) get a client
  only when the latest probe passed with the current keys and found the bucket
  private (`storage_destination_unverified` otherwise). Rotating keys clears
  the probe.
- **Network policy.** The endpoint must be public HTTPS. Every connection
  resolves the host again and connects only to an approved public address, so
  DNS rebinding to a private or metadata address is refused. An operator can
  allow an exact origin on a private network (for example an in-cluster MinIO)
  with `PAPERCLIP_STORAGE_PRIVATE_ORIGINS=http://minio.internal:9000` (comma
  separated, compared as origins). Such an endpoint must use path-style
  addressing, so no bucket-named subdomain of it is dialled. Link-local and
  metadata addresses stay refused even then. A company cannot change this
  list.
- **Encryption modes.** `s3_managed` (default) sends `AES256`. `kms` sends
  `aws:kms` with the key id. For both, the probe fails unless the provider
  confirms the encryption on the object (`encryption_unverified`), because a
  provider that ignores the header stores plaintext. `bucket_default` sends
  nothing, for providers that reject the header but encrypt at rest; the probe
  then reports the encryption as `unverified` unless the provider reports it.
- **Idempotent create.** The client generates the destination id. The same id
  and payload return the existing destination (200); a different payload under
  that id is 409.

## Probe

`POST …/destinations/:id/probe` runs, with a 30-second limit:

1. PUT 32 random bytes to `<prefix>/paperclip-probe/<probeId>` with the
   destination's encryption mode;
2. HEAD: the size must match, and the reported encryption is recorded;
3. GET: the SHA-256 must match;
4. an unauthenticated GET of the same object, addressed the way the S3 client
   addresses the bucket (path style for dotted bucket names and IP hosts):
   success means the bucket is public and the probe **fails**; if the check
   cannot run, the probe fails too (`public_read_unverified`);
5. when there is a prefix, a one-byte PUT outside it
   (`<parent>/paperclip-isolation-probe/<probeId>`): success is recorded as
   `bucket_wide` (the key is not limited to the prefix) and the object is
   deleted (the probe fails if it cannot be deleted); a refusal is
   `prefix_scoped`. This check does not otherwise fail the probe;
6. DELETE of the probe object, with its own 10-second limit.

The result says `passed` or `failed`, with one of these error codes and a fixed
message (provider error text is never returned): `credentials_unavailable`,
`endpoint_unavailable` (one code for unreachable and policy-refused
endpoints, so the probe cannot map internal names), `invalid_credentials`,
`access_denied`, `bucket_not_found`, `encryption_unsupported`,
`encryption_mismatch`, `encryption_unverified`, `read_mismatch`,
`public_read`, `public_read_unverified`, `location_unavailable`,
`cleanup_failed`, `timeout`, `probe_failed`.

## Audit

Create, key rotation, retire and probe each write an activity row
(`storage.destination_created`, `…_credentials_rotated`, `…_retired`,
`…_probed`) with no secret values, in the same transaction as the change.
Every key read is recorded in `secret_access_events` with consumer type
`storage_destination` and the acting user (probe) or the system (archive).

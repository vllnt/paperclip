# Company Storage Destinations

A storage destination is an organization's own S3-compatible bucket (AWS S3,
Cloudflare R2, MinIO, OVH and others). It is the S3-01 part of the company S3
storage plan. The company archive uses it first; asset storage can use it
later.

Board users manage destinations in **Company Settings → Storage
destinations**, through `/api/companies/:companyId/storage/destinations`, or
with `paperclipai storage destinations` (see [CLI.md](CLI.md)). Agents cannot
manage them. On cloud-managed instances every storage route answers 403,
because the platform owns storage there.

## What a destination holds

| Field | Rule |
|---|---|
| Location | HTTPS endpoint origin, region, bucket, prefix, path-style flag, encryption mode. **Immutable**: a change is a new destination. |
| Credentials | Two company secrets: the access key id and the secret access key. Their current versions are pinned when they are set, and two `company_secret_bindings` rows (target type `storage_destination`) record the use. There is no fallback to instance or ambient AWS credentials. |
| Revisions | `revision` changes on every update; `credentialRevision` on every key rotation. Rotate and retire take the expected revision and answer 409 when it is stale. |
| Last probe | The result of the latest probe (below). A key rotation clears it. |

Paperclip never creates buckets, bucket policies, ACLs or lifecycle rules, and
never deletes objects except its own probe objects. Retiring a destination
stops its use and deletes nothing.

## Rules

- **One bucket per organization on an instance.** A destination cannot be
  created when another organization on the same instance has an active
  destination with the same endpoint host and bucket, whatever the prefix. The
  error does not say which organization uses it.
- **Network policy.** The endpoint must be public HTTPS. Every connection
  resolves the host again and connects only to an approved public address, so
  DNS rebinding to a private or metadata address is refused. An operator can
  allow an exact origin on a private network (for example an in-cluster MinIO)
  with `PAPERCLIP_STORAGE_PRIVATE_ORIGINS=http://minio.internal:9000` (comma
  separated). Link-local and metadata addresses stay refused even then. A
  company cannot change this list.
- **Encryption modes.** `s3_managed` (default) sends `AES256`. `kms` sends
  `aws:kms` with the key id. `bucket_default` sends nothing, for providers that
  reject the header but encrypt at rest; the probe then reports the encryption
  as `unverified` unless the provider reports it.
- **Idempotent create.** The client generates the destination id. The same id
  and payload return the existing destination (200); a different payload under
  that id is 409.

## Probe

`POST …/destinations/:id/probe` runs, with a 30-second limit:

1. PUT 32 random bytes to `<prefix>/paperclip-probe/<probeId>` with the
   destination's encryption mode;
2. HEAD: the size must match, and the reported encryption is recorded;
3. GET: the SHA-256 must match;
4. an unauthenticated GET of the same object: success means the bucket is
   public, and the probe **fails**;
5. when there is a prefix, a one-byte PUT outside it
   (`<parent>/paperclip-isolation-probe/<probeId>`): success is recorded as
   `bucket_wide` (the key is not limited to the prefix) and the object is
   deleted; a refusal is `prefix_scoped`. This check does not fail the probe;
6. DELETE of the probe object, with its own 10-second limit.

The result says `passed` or `failed`, with one of these error codes and a fixed
message (provider error text is never returned): `credentials_unavailable`,
`endpoint_rejected`, `endpoint_unreachable`, `invalid_credentials`,
`access_denied`, `bucket_not_found`, `encryption_unsupported`,
`encryption_mismatch`, `read_mismatch`, `public_read`, `cleanup_failed`,
`timeout`, `probe_failed`.

## Audit

Create, key rotation, retire and probe each write an activity row
(`storage.destination_created`, `…_credentials_rotated`, `…_retired`,
`…_probed`) with no secret values. Every key read is recorded in
`secret_access_events` with consumer type `storage_destination`.

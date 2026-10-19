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
stops its use and deletes nothing. Besides the prefix, Paperclip writes one
object: the ownership marker `.paperclip/owner.json` at the bucket root.

## Rules

- **One bucket per organization on an instance.** The first organization
  whose probe passes for a bucket claims it, in two ways:
  - **In the database:** another organization cannot create a destination for
    the same endpoint host and bucket (any prefix): 409 `location_unavailable`.
    Hosts are compared lowercased, without a trailing dot and with default
    ports folded, and every AWS S3 regional, dualstack and legacy host counts
    as one.
  - **In the bucket:** the probe writes the ownership marker
    `.paperclip/owner.json` at the bucket root (destination id and a random
    value kept in the database), with a conditional write, and reads it back.
    A claim that could overwrite another one is no claim, so the provider must
    enforce `If-None-Match: *`. Before the first claim the probe writes one
    fresh key under its prefix twice with that header; the second write must
    be refused with 412. A provider that ignores or rejects the header cannot
    claim a bucket: the probe fails and answers 422
    `atomic_claim_unsupported`. AWS S3, Cloudflare R2 and MinIO enforce it.
    Every probe reads the marker first. A marker of another organization, of
    a destination this instance does not know, or one that is not a Paperclip
    marker makes the probe answer 409 `location_unavailable`, whatever host
    name was used, so two DNS names for one service cannot share a bucket.
  - An unproven destination claims nothing, so a bucket cannot be squatted with
    keys that do not work; an older unproven one fails its probe once another
    organization claims the bucket. The error does not say which organization
    uses it.
  - **The claim outlives retirement.** Retiring deletes nothing, so the bucket
    may still hold the organization's objects, and its claim and marker stay.
    There is no release yet; to reuse a bucket for another organization, empty
    it and delete the marker outside Paperclip.
- **Marker access.** The access key must be able to read and write
  `.paperclip/owner.json` at the bucket root. A key limited to the prefix
  needs that one object added to its policy; without it the probe fails with
  `ownership_unverified`.
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
  `aws:kms` with the key id. The probe requires exactly what was asked for on
  the stored object: `AES256` for `s3_managed`, `aws:kms` for `kms` and, when
  the provider names the key, that key (give the key id or ARN; an alias
  cannot be compared). Nothing reported is `encryption_unverified`; anything
  else is `encryption_mismatch`. A provider that ignores the header stores
  plaintext. `bucket_default` sends nothing, for providers that reject the
  header but encrypt at rest; the probe reports `unverified` when the provider
  reports nothing, `verified` for `AES256` or `aws:kms`, and fails on any
  other value.
- **Idempotent create.** The client generates the destination id. The same id
  and payload return the existing destination (200); a different payload under
  that id is 409.

## Probe

`POST …/destinations/:id/probe` runs, with a 30-second limit:

1. GET of the ownership marker at the bucket root (see Rules); another
   organization's marker stops the probe with 409 before anything is written;
2. PUT 32 random bytes to `<prefix>/paperclip-probe/<probeId>` with the
   destination's encryption mode;
3. HEAD: the size must match, and the encryption must be exactly the one asked
   for;
4. GET of at most 33 bytes: the SHA-256 must match, and a longer body is a
   mismatch;
5. an unauthenticated GET of the same object, addressed the way the S3 client
   addresses the bucket (path style for dotted bucket names and IP hosts). It
   is never redirected. Only 401 or 403 proves the bucket private; a 2xx means
   it is public and the probe **fails** (`public_read`); a redirect, any other
   status or a failed request fails it too (`public_read_unverified`);
6. when there is a prefix, a one-byte PUT outside it
   (`<parent>/paperclip-isolation-probe/<probeId>`): success is recorded as
   `bucket_wide` (the key is not limited to the prefix) and the object is
   deleted (the probe fails if it cannot be deleted); a refusal is
   `prefix_scoped`. This check does not otherwise fail the probe;
7. when the bucket has no marker yet: the conditional-write check (a fresh
   key written twice with `If-None-Match: *`, then deleted;
   `atomic_claim_unsupported` unless the second write gets 412), then the
   conditional write of this organization's marker and a read-back
   (`location_unavailable` if another claim won). There is no fallback to a
   plain write;
8. DELETE of the probe object, with its own 10-second limit. It also runs
   after a PUT that failed without saying whether the object was stored.

The result says `passed` or `failed`, with one of these error codes and a fixed
message (provider error text is never returned): `credentials_unavailable`,
`endpoint_unavailable` (one code for unreachable and policy-refused
endpoints, so the probe cannot map internal names), `invalid_credentials`,
`access_denied`, `bucket_not_found`, `encryption_unsupported`,
`encryption_mismatch`, `encryption_unverified`, `read_mismatch`,
`public_read`, `public_read_unverified`, `location_unavailable`,
`ownership_unverified`, `atomic_claim_unsupported`, `cleanup_failed`,
`timeout`, `probe_failed`. `atomic_claim_unsupported` is a 422.
`location_unavailable` is also the probe's HTTP status: 409, as on create,
on the web page, in the API and in the CLI (which exits 1).

## Audit

Create, key rotation, retire and probe each write an activity row
(`storage.destination_created`, `…_credentials_rotated`, `…_retired`,
`…_probed`) with no secret values, in the same transaction as the change.
Every key read is recorded in `secret_access_events` with consumer type
`storage_destination` and the acting user (probe) or the system (archive).

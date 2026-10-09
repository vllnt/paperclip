---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Requires a board user. Returns companies where the user has active membership.
Instance administrators and the local trusted board can list all companies.

For navigation and company selectors, use `GET /api/companies?scope=accessible`.
This returns only companies the caller can enter through company-scoped routes,
including for instance administrators. Instance administrator status alone does
not grant access to a company's contents. The local trusted board can still
enter all companies. The board UI uses this scope for its company list, so it
does not select companies the user cannot open.
The Instance Access screen uses the unscoped directory so administrators can
manage membership for all companies. A supplied `scope` must be a single
`accessible` value; empty, unknown, or repeated values return `400`.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal Paperclip attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Environment Leases

A lease records a run's hold on an execution environment (an SSH host or a
sandbox). Statuses: `active`, `released`, `expired`, `failed`, `retained`,
`pending_cleanup`. Both routes below are read-only and board-only (agents get
`403`).

### List Leases Of One Environment

```
GET /api/environments/{environmentId}/leases?status=active,failed
```

`status` is an optional comma-separated list of lease statuses; without it every
status is returned. An unknown status returns `400`.

### List Leases Across A Company

```
GET /api/companies/{companyId}/environment-leases?status=active,pending_cleanup
```

Returns the company's leases across environments, most recently used first. Each
lease carries `environment: { id, name, driver }`, or `null` for an orphan
`pending_cleanup` lease whose environment was deleted.

| Query | Default | Values |
|-------|---------|--------|
| `status` | `active,pending_cleanup` | Comma-separated lease statuses; unknown values return `400` |

Authorization: the per-environment gate (board user with company membership or
instance admin) plus access to `{companyId}`, because the rows are the company's
own leases. A board user of another company gets `403`. Lease `metadata` is
passed through the secret redactor, so secret-looking values are masked.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional Paperclip asset content path for the stored logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |

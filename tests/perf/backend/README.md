# Backend performance

Tools that measure the server. The plan is `doc/plans/2026-10-10-backend-effect.md`.

## `prod-readonly.mjs`: read-only latency on a running instance

The script measures a running Paperclip instance and changes nothing. It sends only `GET` requests, one at a time. It takes the B0 numbers on production (plan section 4.7). It also re-measures the touched routes after a change is deployed.

```sh
PAPERCLIP_API_URL=https://<host> PAPERCLIP_API_KEY=<board key> \
  node tests/perf/backend/prod-readonly.mjs run \
    --company-id <company id> --issue <issue id or identifier> \
    --n 30 --label before --out before.json

node tests/perf/backend/prod-readonly.mjs compare before.json after.json --only dashboard,issues-default
```

- The key comes only from the environment. The script does not print it or write it to a file.
- Each round sends one request to each route, in a fixed order. Slow drift on the host affects all routes alike.
- Each request opens a new connection. `serverMs` is the time from the end of the TLS handshake to the first response byte. It still contains one network round trip.
- `workMs` subtracts the p50 of `GET /api/health` (the floor) from `serverMs`. Use `workMs` to compare routes. Use `serverMs` to compare two runs.
- For each route, the first round also records the body size with and without compression, the `Content-Encoding`, the `ETag`, the status of a conditional request with that `ETag`, `Vary` and `Cache-Control`.
- The host load and memory come from `GET /api/instance/resource-capacity` every 30 s. This needs an instance-admin board key. The client's own 1-minute load average is recorded at the start and at the end, because a busy client adds time to every request.
- With `--n 30`, p95 is the 29th of 30 values and p99 is the maximum. Use `--n 60` or more when a decision depends on the tail.
- `compare` gives the change of p50 and p95 of `serverMs` with a 95% bootstrap interval (2,000 resamples, fixed seed). A row passes when the upper end of the interval is at most the threshold (default: p50 +3%, p95 +5%). It fails when the lower end is above the threshold. In every other case it is inconclusive. Take more samples for an inconclusive row. Do not count it as a pass.
- The routes are listed in `ROUTES` at the top of the file. `--only a,b` limits a run to some routes. The health route always runs, because it gives the floor.

The script uses only Node built-ins. It sends nothing to an outside service.

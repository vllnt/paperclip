# Backend performance

Tools that measure the server. The plan is `doc/plans/2026-10-10-backend-effect.md`.

## `prod-readonly.mjs`: GET-only latency on a running instance

The script measures a running Paperclip instance. It sends only `GET` requests. A `GET` handler can still write housekeeping data, the same as a page view in the UI. Known cases: the `lastUsedAt` time of the key, the revalidation of a source recovery on `GET /api/issues/:id`, and the import of the bundled skills on the skills list. So the script sends no write request, but it does not leave the instance untouched. It takes the B0 numbers on production (plan section 4.7). It also re-measures the touched routes after a change is deployed.

This script is a local measuring tool for maintainers. It is not a user-facing capability, so it has no web, REST or CLI counterpart.

```sh
PAPERCLIP_API_URL=https://<host> PAPERCLIP_API_KEY=<board key> \
  node tests/perf/backend/prod-readonly.mjs run \
    --company-id <company id> --issue <issue id or identifier> \
    --n 30 --label before --out before.json

node tests/perf/backend/prod-readonly.mjs compare before.json after.json --only dashboard,issues-default
node tests/perf/backend/prod-readonly.mjs compare before.json after.json --aa first.json,second.json
```

Inside an agent run, `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` are already set. They point at the instance of that run, with the key of that run. Set both yourself for any other target.

### `run`

- The key comes only from the environment. The script does not print it or write it to a file. The report keeps the route templates (`/api/companies/{c}/dashboard`), not the company id or the issue id.
- The script refuses `http:` with a key unless the host is loopback (`localhost`, `127.x.x.x`, `::1`), because the key would cross the network in clear text. It refuses `--gap-ms 0` unless the host is loopback, because the requests would go back to back. `--n` and `--gap-ms` must be integers (at least 1 and at least 0). The run starts only when `GET /api/health` answers 200.
- Each round sends one request to each route, one at a time, with `--gap-ms` (default 250) of pause after each. The order of the routes is shuffled in every round, from a fixed seed, so no route always follows the same route. Slow drift on the host affects all routes alike.
- Each request opens a new connection. A request fails after 60 s of idle time: this is an idle timeout (no data on the socket), not a limit on the whole request. `serverMs` is the time from the end of the TLS handshake to the first response byte. It still contains one network round trip.
- `workMs` subtracts the p50 of `GET /api/health` (the floor) from `serverMs`. Use `workMs` to compare routes. Use `serverMs` to compare two runs.
- `--accept-encoding` (default `gzip`) sets the header of the measured requests. The report records it. The script decodes `gzip`, `br` and `deflate`. Use the same value in the runs that you compare.
- For each route, the first round also records the body size with and without compression (`wireBytes`, `identityBytes`), the `Content-Encoding`, the `ETag`, the status of a conditional request with that `ETag`, `Vary` and `Cache-Control`.
- A host sampler runs next to the requests. It reads `GET /api/instance/resource-capacity` at the start, every 30 s, and at the end. This needs an instance-admin board key. The sampler sends its request on its own connection, at the same time as the measured request, so it can add a little time to one sample. The client's own 1-minute load average is recorded at the start and at the end, because a busy client adds time to every request. Record both loads with every run, and use a client with a similar load for the "after" run.
- With `--n 30`, p95 is the 29th of 30 values and p99 is the maximum. Use `--n 60` or more when a decision depends on the tail.
- The routes are listed in `ROUTES` at the top of the file. `--only a,b` limits a run to some routes. The health route always runs, because it gives the floor.
- A route with a p50 of 0 in `workMs` is below the resolution of the method: its p50 is not above the p50 of the health route.

### `compare`

`compare` gives the change of p50 and p95 of `serverMs` with a 95% bootstrap interval (2,000 resamples, fixed seed). There is no pass or fail and there is no threshold. The interval treats the samples of one run as independent. They are not, because two runs of the same commit drift on a shared host. So each row gets a label:

| Label | Meaning |
| --- | --- |
| `slower` | The whole interval is above the noise. |
| `faster` | The whole interval is below the noise. |
| `within A/A noise` | `--aa` was given, and the interval does not clear the noise. |
| `no clear change` | `--aa` was not given, and the interval includes 0. Read it as a trend only. |
| `no A/A data` | A route has fewer than 5 samples in an A/A run. |
| `MORE FAILURES` | A line above the route: the share of answers that are not 200 is higher than before. |

- `--aa first.json,second.json` takes two runs of the same commit. For each route and each statistic, the noise is the larger of the two changes between them, taken in both directions. A change counts only beyond that noise. This is not the paired rule of section 8 of the plan.
- A route with fewer than 5 samples that answered 200 is skipped ("too few 200 samples").
- If the wire size of a route differs between the two runs, `compare` prints both values.

### Tests

`prod-readonly.test.mjs` is a `node:test` file. It starts a local HTTP server and the real script, so it needs no instance and no outside network. It checks the labels of `compare` (with and without `--aa`), the `MORE FAILURES` flag, that `run` sends only `GET`, keeps the route templates and never writes the key, that the script refuses a clear-text key and a fast loop on a remote host, and that it rejects a bad `--n` before it sends anything.

```sh
pnpm run test:perf-prober
# or: node --test tests/perf/backend/prod-readonly.test.mjs
```

The script uses only Node built-ins. It sends nothing to an outside service.

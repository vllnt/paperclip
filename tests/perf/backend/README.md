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

## Fault runs: F1, F4 and the statement census

Test code for `doc/plans/2026-10-10-backend-effect.md` (sections 4 and 8). Nothing in this section runs in CI or against a shared or production instance. Every run starts its own embedded Postgres on loopback and removes it at the end.

| File | What it does |
| --- | --- |
| `fault-proxy.mjs` | A TCP proxy between a Postgres client and the database. It forwards bytes, counts the statements the client sends (Query and Execute messages), the statements in flight, the connections accepted per second and the peak open connections, and injects faults: `flap` (hold each new connection, reset each connection after a set life), `refuse` (close the listener and reset the open connections), `stall` (stop forwarding for a set time, then reset). Node built-ins only. |
| `faults.mjs f1` | F1 at helper level, no server: a real query through `retryIdempotentDatabaseOperation` at a fixed rate (open loop) while a loop ends the database backends every 25 ms, and a slow-failure case in which the proxy stalls every connection and then resets it. Two or more versions of the helper ("arms") run in interleaved trials. |
| `faults.mjs f4` | F4 at route level: the real server of each arm's checkout, behind the proxy, under the dashboard load, through a flap and a blackout. Two server configurations: `auth` (authenticated mode with the cloud-tenant trust token, so every request runs the actor lookup) and `wake` (assignments whose wake is delivered after the response). |
| `faults.mjs census` | The per-route statement census: the statements one healthy request of each read route sends, at two or more data sizes, to show which routes are N+1 shaped. |
| `lib/server.mjs` | Starts a checkout's server from source as a child process against a given database, in a temporary home with a minimal environment, and waits until `/api/health` reports `ok`. |
| `lib/stats.mjs` | Quantiles, the distribution-free interval of the median of paired differences, the pass, fail or inconclusive rule of section 8 (fewer than 10 pairs are always inconclusive), and the pairs a row needs. |
| `lib/census.mjs` | The rows of a census response and the growth rule that marks a route N+1 shaped or `unmeasured`. |
| `harness.test.mjs` | Self-tests of the statistics, the census rule, the server launcher (against a stand-in checkout) and the proxy's four modes (against a stand-in database), with no Postgres: `node --test tests/perf/backend/harness.test.mjs` (a few seconds). |

### Before a run

- The machine is shared. Take the heavy-run lock that the operators use, run in a quiet window, and record `uptime` with the result.
- At least 9,000 MiB of free disk before and after (plan section 1).
- Install the dependencies of the checkout (`pnpm install --offline --frozen-lockfile`).

### F1

```sh
mkdir -p tmp/perf
git show <base-sha>:server/src/database-retry.ts > tmp/perf/base-database-retry.ts
NODE_ENV=production PAPERCLIP_LOG_LEVEL=warn \
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs f1 \
  --arm base=$PWD/tmp/perf/base-database-retry.ts \
  --arm candidate=$PWD/server/src/database-retry.ts \
  --out tmp/perf/f1.json
```

A base file taken with `git show` must have no relative imports. A candidate inside a checkout may import its neighbours. An arm file must export `retryIdempotentDatabaseOperation`, and `isTransientDatabaseError` when the wide predicate runs; the run stops at once if one is missing.

Defaults: rates 20 and 77 calls a second, faults of 0.3 s, 1 s and 3 s, 10 trials per case, the default and the wide predicate, 10 s of steady calls before each fault (so the retry budget sees a running process), 5 s after it, and a 3 s stall. The stall case runs once per predicate: the default predicate does not retry the reset that ends a stall, so only the wide one shows what a retry costs there. One trial of each arm alternates with the other, and the order flips on every trial. The full default run takes about 90 minutes.

The report gives, per case and arm: the calls started during the fault, the share of them that failed, the error codes of the failures, the longest call, the failures outside the fault, and the unhandled rejections. It is rewritten after every case. A case that throws is recorded as an `error` entry, the run goes on with the next case, and the exit code is 1.

**Unhandled rejections.** Before #301, the repository patch of postgres.js 3.4.9 did not handle a failed array-type fetch on a new connection. A backend that died while a connection started then raised an unhandled rejection, and the server exits on one. The harness counts them per trial instead of exiting, so a checkout from before #301 can still be measured; on a checkout with #301 the count should be 0.

### F4

```sh
NODE_ENV=production \
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs f4 \
  --arm base=/abs/path/to/base-checkout \
  --arm candidate=/abs/path/to/candidate-checkout \
  --out tmp/perf/f4.json
```

An arm is a checkout with its dependencies installed. Its server runs from source (`server/src/index.ts`) with its own tsx loader, so the two arms can be two worktrees, for example `main` and the slice. Every run starts a new embedded Postgres and a new server, and the server reaches the database only through the proxy. Its boot-time migration check goes straight to the database (`DATABASE_MIGRATION_URL`), so it stays off the counters.

One run, 70 s by default: `steady` 20 s, `flap` 10 s (the proxy holds each new connection 300 ms, connects it, then resets it 100 ms later; the open connections are reset 100 ms after the switch), `recover` 20 s, `blackout` 10 s (the proxy refuses every connection), `tail` 10 s. Change a phase with `--steady`, `--flap`, `--recover`, `--blackout` or `--tail` in ms; 0 skips it. The flap values are fixed in the code, so every arm gets the same fault.

- `auth`: the dashboard at `--dashboard-rate` (19 a second: the four helper calls of a dashboard request give the B0 rate of about 77 helper calls a second) and `GET /api/auth/get-session` at `--auth-rate` (20 a second), both with the trust headers of a cloud-tenant member, so every request runs the actor lookup.
- `wake`: the dashboard at the same rate, and assignments at `--assign-rate` (5 a second). Each assignment assigns a new unassigned `todo` issue, so every 2xx answer must leave exactly one `issue-assignment:` wake row. The run then waits 30 s and counts, per phase, the assignments whose row exists. The agent has `wakeOnDemand: false`, so the row is a `skipped` receipt, not a queued wake; the key is the same and the count still shows whether the post-response write ran. The match also depends on the board actor: a system-requested wake coalesces and takes the key `execution-wait:<digest>` (`coalesceExecutionWait` in `heartbeat.ts`), and the `issue-assignment:` match would read 0%. The plan names a board API key for this run so that the actor lookup does not run; the runner uses `local_trusted` mode, which skips that lookup in the same way and needs no key.
- Pairs: `--pairs` (5). Each pair runs every configuration for every arm, and the arm order flips on every pair. The report is rewritten after every run; a run that throws (a seed request with HTTP 300 or more, a server not ready in 180 s) is recorded as an `error` entry, the next run starts, and the exit code is 1.
- Control: `--flap 0 --blackout 0` runs the same load in pass mode only. Run it on the base arm before the first gate, so that a long request on `main` can be told from an artifact of the proxy or the load.

Before the load, each run takes a census of its own routes: the statements one healthy request sends, minus the server's idle background rate. The report gives, per run and phase: statements (total, per second, busiest second), connections accepted per second, peak open connections, peak statements in flight, resets and the median life of a reset connection opened in the phase (the failed-attempt time of the plan's auth bound), the plan's statement bound (counting every request active in the phase, since a request that a fault holds sends its statements later) and whether the phase stayed within it, the refused retries read from the server's `database retry budget refused retries` warnings, and per route the requests, failures, longest request and status counts, plus the wake share for assignments. It also records an exit of the server during the run.

### Census

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs census \
  --sizes 10,100 --out tmp/perf/census.json
```

For each size, a new database and server (`local_trusted`, behind the proxy in pass mode) with one company, `size` issues of two comments each, one agent per ten issues, and `size` comments in all on the last issue (the target of the two issue routes). Sizes above 300 are refused: they need more than 30 agents, and the agent create route allows 30 a minute. Each route of the production B0 list gets one warm-up request and then `--samples` (30) sequential ones. The idle background rate, taken over 10 s, is subtracted.

The report gives, per route and size, the statements per request and the **rows the response returned** (the length of the list, or of its longest array; for the dashboard, the agents and the open and done tasks its counters cover). A count that stays flat means something only when the response had more rows to build, so:

- `measured`: the response returned more rows at the largest size than at the smallest. The report gives the extra statements per extra returned row and per extra agent (the seed has one agent per ten issues, so a statement per agent alone would read 0.1 a row). A route at 0.5 or more on either is `nPlusOneShaped: true`.
- `unmeasured`: the response did not grow, so `nPlusOneShaped` is `null`, not `false`. The seed creates no skills, runs, approvals or thread interactions, so a route that depends on them (`skills`, `live-runs`, `heartbeat-runs`, `sidebar-badges`, and `attention` where its items come from those) shows `unmeasured` until the seed creates that data. Do not pick an L3 batching route from a flat `unmeasured` row.

The report is rewritten after each size. A size that throws is recorded under `errors`, the other sizes still give their numbers, and the exit code is 1.

# Backend perf harness: fault runs

Test code for `doc/plans/2026-10-10-backend-effect.md` (sections 4 and 8). Nothing here runs in CI or against a shared or production instance. Every run starts its own embedded Postgres on loopback and removes it at the end.

| File | What it does |
| --- | --- |
| `fault-proxy.mjs` | A TCP proxy between a Postgres client and the database. It forwards bytes, counts the statements the client sends (Query and Execute messages), the statements in flight, the connections accepted per second and the peak open connections, and injects faults: `flap` (hold each new connection, reset each connection after a set life), `refuse` (close the listener and reset the open connections), `stall` (stop forwarding for a set time, then reset). Node built-ins only. |
| `faults.mjs f1` | F1 at helper level, no server: a real query through `retryIdempotentDatabaseOperation` at a fixed rate (open loop) while a loop ends the database backends every 25 ms, and a slow-failure case in which the proxy stalls every connection and then resets it. Two or more versions of the helper ("arms") run in interleaved trials. |
| `faults.mjs f4` | F4 at route level: the real server of each arm's checkout, behind the proxy, under the dashboard load, through a flap and a blackout. Two server configurations: `auth` (authenticated mode with the cloud-tenant trust token, so every request runs the actor lookup) and `wake` (assignments whose wake is delivered after the response). |
| `faults.mjs census` | The per-route statement census: the statements one healthy request of each read route sends, at two or more data sizes, to show which routes are N+1 shaped. |
| `lib/server.mjs` | Starts a checkout's server from source as a child process against a given database, in a temporary home with a minimal environment, and waits until `/api/health` reports `ok`. |
| `lib/stats.mjs` | Quantiles, the distribution-free interval of the median of paired differences, the pass, fail or inconclusive rule of section 8, and the pairs a row needs. |

## Before a run

- The machine is shared. Take the heavy-run lock that the operators use, run in a quiet window, and record `uptime` with the result.
- At least 9,000 MiB of free disk before and after (plan section 1).
- Install the dependencies of the checkout (`pnpm install --offline --frozen-lockfile`).

## F1

```sh
git show <base-sha>:server/src/database-retry.ts > tmp/perf/base-database-retry.ts
NODE_ENV=production PAPERCLIP_LOG_LEVEL=warn \
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs f1 \
  --arm base=$PWD/tmp/perf/base-database-retry.ts \
  --arm candidate=$PWD/server/src/database-retry.ts \
  --out tmp/perf/f1.json
```

A base file taken with `git show` must have no relative imports. A candidate inside a checkout may import its neighbours.

Defaults: rates 20 and 77 calls a second, faults of 0.3 s, 1 s and 3 s, 10 trials per case, the default and the wide predicate, 10 s of steady calls before each fault (so the retry budget sees a running process), 5 s after it, and a 3 s stall. One trial of each arm alternates with the other, and the order flips on every trial. The full default run takes about 80 minutes.

The report gives, per case and arm: the calls started during the fault, the share of them that failed, the error codes of the failures, the longest call, the failures outside the fault, and the unhandled rejections.

**Unhandled rejections.** Before #301, the repository patch of postgres.js 3.4.9 did not handle a failed array-type fetch on a new connection. A backend that died while a connection started then raised an unhandled rejection, and the server exits on one. The harness counts them per trial instead of exiting, so a checkout from before #301 can still be measured; on a checkout with #301 the count should be 0.

## F4

```sh
NODE_ENV=production \
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs f4 \
  --arm base=/abs/path/to/base-checkout \
  --arm candidate=/abs/path/to/candidate-checkout \
  --out tmp/perf/f4.json
```

An arm is a checkout with its dependencies installed. Its server runs from source (`server/src/index.ts`) with its own tsx loader, so the two arms can be two worktrees, for example `main` and the slice. Every run starts a new embedded Postgres and a new server, and the server reaches the database only through the proxy. Its boot-time migration check goes straight to the database (`DATABASE_MIGRATION_URL`), so it stays off the counters.

One run, 70 s by default: `steady` 20 s, `flap` 10 s (the proxy holds each new connection 300 ms, then resets it 100 ms after it was accepted), `recover` 20 s, `blackout` 10 s (the proxy refuses every connection), `tail` 10 s. Change a phase with `--steady`, `--flap`, `--recover`, `--blackout` or `--tail` in ms; 0 skips it. The flap values are fixed in the code, so every arm gets the same fault.

- `auth`: the dashboard at `--dashboard-rate` (19 a second: the four helper calls of a dashboard request give the B0 rate of about 77 helper calls a second) and `GET /api/auth/get-session` at `--auth-rate` (20 a second), both with the trust headers of a cloud-tenant member, so every request runs the actor lookup.
- `wake`: the dashboard at the same rate, and assignments at `--assign-rate` (5 a second). Each assignment assigns a new unassigned `todo` issue, so every 2xx answer must queue exactly one wake. The run then waits 30 s and counts, per phase, the assignments whose `issue-assignment:` wake row exists. The plan names a board API key for this run so that the actor lookup does not run; the runner uses `local_trusted` mode, which skips that lookup in the same way and needs no key.
- Pairs: `--pairs` (5). Each pair runs every configuration for every arm, and the arm order flips on every pair.

Before the load, each run takes a census of its own routes: the statements one healthy request sends, minus the server's idle background rate. The report gives, per run and phase: statements (total, per second, busiest second), connections accepted per second, peak open connections, peak statements in flight, resets and the median life of a reset connection (the failed-attempt time of the plan's auth bound), the plan's statement bound and whether the phase stayed within it, the refused retries read from the server's `database retry budget refused retries` warnings, and per route the requests, failures, longest request and status counts, plus the wake share for assignments. It also records an exit of the server during the run.

## Census

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs tests/perf/backend/faults.mjs census \
  --sizes 10,100 --out tmp/perf/census.json
```

For each size, a new database and server (`local_trusted`, behind the proxy in pass mode) with one company, `size` issues of two comments each, and one agent per ten issues. Each route of the production B0 list gets one warm-up request and then `--samples` (30) sequential ones. The idle background rate, taken over 10 s, is subtracted. The report gives the statements per request at each size and the extra statements per extra issue; a route at 0.5 or more per issue is marked N+1 shaped. Routes whose cost depends on data the seed does not create (skills, runs) can only show what this seed exercises.

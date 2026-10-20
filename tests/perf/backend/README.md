# Backend perf harness: fault runs

Test code for `doc/plans/2026-10-10-backend-effect.md` (sections 4 and 8). Nothing here runs in CI or against a shared or production instance. Every run starts its own embedded Postgres on loopback and removes it at the end.

| File | What it does |
| --- | --- |
| `fault-proxy.mjs` | A TCP proxy between a Postgres client and the database. It forwards bytes, counts the statements the client sends (Query and Execute messages), the statements in flight, the connections accepted per second and the peak open connections, and injects faults: `flap` (hold each new connection, reset each connection after a set life), `refuse` (close the listener and reset the open connections), `stall` (stop forwarding for a set time, then reset). Node built-ins only. |
| `faults.mjs f1` | F1 at helper level, no server: a real query through `retryIdempotentDatabaseOperation` at a fixed rate (open loop) while a loop ends the database backends every 25 ms, and a slow-failure case in which the proxy stalls every connection and then resets it. Two or more versions of the helper ("arms") run in interleaved trials. |
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

**Unhandled rejections.** postgres.js 3.4.9 without the repository patch of 2026-10-20 does not handle a failed array-type fetch on a new connection. A backend that dies while a connection starts then raises an unhandled rejection, and the server exits on one. The harness counts them per trial instead of exiting, so that both arms are measured.

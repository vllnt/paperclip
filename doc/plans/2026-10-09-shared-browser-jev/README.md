# Shared Browser: Jev benchmark evidence

Supports section 8 of [`../2026-10-09-shared-browser.md`](../2026-10-09-shared-browser.md).
Run on 2026-10-09 against `agent-browser` 0.38.1 and the Vercel AI Gateway.

| File | What it is |
| --- | --- |
| `capture.mjs` | Drives agent-browser through 3 flows on public automation-practice sites and records, per step, the accessibility snapshot, candidate actions and ground-truth labels. Labels are written in the flow spec before capture. |
| `dataset.json` | The 30 captured steps. |
| `capture-stats.json` | Real clicks issued by the loop and how many had no visible effect. |
| `bench.mjs` | Asks `typesafe-ai/jev`, `anthropic/claude-sonnet-5` and `anthropic/claude-haiku-4.5` the same four questions per step and prints accuracy, latency, cost and the confidence-router table. |
| `results.json` | Raw per-step results from the run reported in the plan (no credentials; errors are recorded by class name only). |

## Reproduce

Needs Node 24, `agent-browser`, and an AI Gateway key in the environment. Keep the key in a private env file and load it with `--env-file`; the scripts never print it.

```sh
mkdir /tmp/jev-bench && cd /tmp/jev-bench
cp <this directory>/capture.mjs <this directory>/bench.mjs .
pnpm add ai@7        # the run used 7.0.127 (experimental_evaluate); newer 7.x names it experimental_decide
node capture.mjs     # rewrites dataset.json from the live sites
node --env-file=<private env file> bench.mjs
```

## Limits

- 30 steps; one or two steps of difference is noise.
- Public practice sites with small snapshots (about 900 characters on average), not the operator's services.
- The gateway team's model allowlist blocked Sonnet 5.5 and Haiku 5.5 (HTTP 403), so Sonnet 5 and Haiku 4.5 were the baselines.
- Five steps in the shop flow (add to cart, cart, checkout, continue, finish) were advanced with the page's own click because real clicks on add-to-cart and the cart button were observed to be ignored (see plan section 3.1). The dataset records the page state before each action, so labels are unaffected.

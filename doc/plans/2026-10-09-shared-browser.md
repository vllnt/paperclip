# Shared Browser — company-scoped, persistent browser profiles for agents

Status: Proposed (Phase 0: explore and plan, no product code yet)
Date: 2026-10-09
Feature flag: default off (see [section 11](#11-feature-flag-and-rollout))
Evidence: [`2026-10-09-shared-browser-jev/`](./2026-10-09-shared-browser-jev/) (Jev benchmark: scripts, labelled dataset, raw results)
Review: an independent security review and a citation and number fact-check were run on the first draft; their findings are folded in and listed in [section 16](#16-phase-0-review-log).

## 0. Summary

- **Recommendation.** Add a **browser hub**: for each *active company profile*, one long-lived, headful Chromium in its **own container and network namespace** on a private browser host. Agents never get CDP, a shell on that host, or the profile. They call high-level `browser_*` tools served by the hub as an MCP endpoint, registered as an ordinary remote-MCP connection, so the documented grants, Allowed / Ask first / Off policy, approvals, rate limits and audit are expected to apply unchanged (documented behaviour, verified in PR 6). The executor is **agent-browser** (Apache-2.0) behind a swappable interface, driven only through typed arguments built by the hub (agents never supply flags), with a minimal CDP-direct executor as the fallback if that fence proves leaky (a PR 3 gate).
- **Sharing.** All agents of a company profile share one browser context, so a sign-in is visible to every agent and survives runs. Each agent run gets its own tab handles. A human sign-in takes an exclusive lease: agent calls are drained and agent tabs blanked first.
- **Human sign-in.** A board user opens the profile in the Paperclip UI and drives the real browser through a **VNC-class live view** (noVNC client over one authenticated WebSocket relayed by the Paperclip server). 2FA works because the human types into the real page. DevTools, the cookie UI and the password manager are disabled in that browser.
- **Security.** The profile is credentials. It is sealed at rest (AES-256-GCM, per-profile data key kept as a reserved company secret, AAD bound to company and profile), lives in RAM-backed storage while active, and never leaves the hub. Agents cannot export cookies or storage: no cookie, storage, eval, state or CDP tools; typed arguments only; a navigation allowlist; no listener reachable from the page; Chromium sandbox on. Board-only profile admin under a dedicated permission, per-profile agent allowlist through existing grants, full audit including every committed navigation, and a two-level kill switch with a dead-man timer. Details in [section 10](#10-security-model).
- **PRs.** Eight small PRs, each behind the flag, with tests and typecheck: contracts and flag, hub core, hub executor and tools, server admin and kill switch, live view, agent integration, Jev decision step (optional), dogfood and runbook ([section 12](#12-pr-breakdown)).
- **Infra (operator).** A dedicated small VM (4 vCPU, 8 GiB, 40 GiB) in the EU site on the Tailnet, reachable inbound only from the control plane, with no route from browser containers to the Tailnet or LAN; one hub token. Details in [section 9](#9-where-it-runs-and-infra-requests).
- **Jev result** (30 labelled steps, 3 flows on public practice sites; smoke test, wide error bars): Jev is within one step of Sonnet 5 on page-state, goal-done and needs-human classification (30 / 28 / 29 vs 30 / 29 / 29) at about 1/60 of the cost and 4.5x lower median latency (281 ms vs 1255 ms; p95 359 ms vs 5063 ms). It is worse at choosing the next action (25/30 vs 29/30): two low-confidence picks and two hand-off decisions, one of them at confidence 0.89. Use it for classifiers (hand-off comes from the classifier, never the chooser) and a confidence-gated chooser with an LLM fallback. No security requirement depends on Jev; PR 7 is optional and can be dropped ([section 8](#8-jev-as-a-fast-decision-step-measured)).
- **Decisions needed from the operator:** third-party processing of page snapshots by Jev, the dedicated VM, the dogfood target, and confirmation that nothing weakens the security model ([section 14](#14-risks-open-questions-and-decisions-for-the-operator)).

## 1. Goal, non-goals, constraints

**Goal.** A board user signs in to their services once, in a browser they can see. The login survives between runs and is shared across the agents the board allows, for one company only.

**Non-goals (v1).** Passkeys and hardware keys; file download and upload; recording; captcha solving; stealth or fingerprint spoofing; importing cookies from a person's own browser; any hosted browser vendor; cross-company sharing.

**Constraints that shaped the plan.**
- This repository is public. A guard rejects tailnet names, private IPs, keys and operator paths in new commits (`scripts/check-public-config.py:6-12`; `VLLNT.md`, "Publication safeguards"). This document therefore says "browser host" and "control plane", never a real host name or CIDR.
- Production is Tailnet-only (`VLLNT.md`, "Bundled GitHub plugin": no public webhook route or Funnel). The hub adds no public endpoint.
- Default hosting is self-hosted in the EU. Third-party SaaS needs the operator's approval and is used here for comparison only.

## 2. Prior art in this repository (reuse first)

| Area | Evidence | Reuse, or why it is not enough |
| --- | --- | --- |
| Hosted browser connector with a task Browser tab | `doc/plans/2026-09-29-browser-use-cloud-connector.md`; `doc/connections/BROWSER-USE.md`; `server/src/services/browser-use.ts` (1454 lines); `ui/src/components/task-side-panel/TaskBrowserPanel.tsx` | Reuse the *design*: company-scoped ownership rows, a leased reconciler, viewer credentials fetched on demand by humans and never returned to agents, one viewer lease, cleanup on revoke or reassignment. Not reusable as code: it is a vendor adapter special-cased in `tool-gateway.ts:5918`, `tool-access.ts:2366`, `connector-runtime.ts:63` and `heartbeat.ts`, and it drives a third-party SaaS. |
| Governed tool path for agents | `doc/MCP-ACCESS-GOVERNANCE.md:212` (profiles and bindings), `:254` (scoped grants), `:315` (approvals), `:375` (audit); `doc/connections/GENERIC-REMOTE-MCP.md`; tool profile and grant routes require `tools:admin` (`server/src/routes/tool-gateway.ts:378`) | **Reuse as the agent interface.** A remote MCP server is documented to get grants per agent, Allowed / Ask first / Off, quarantine of new tools, rate limits, signed approvals and an audit trail, expected without gateway changes (verify in PR 6). A revoked scoped grant cannot authorise a later call (`MCP-ACCESS-GOVERNANCE.md:271-274`), but the *effective tool profile* is cached on the gateway session (`:246`), so unbinding a profile alone does not stop a live run. |
| Agent identity reaching the hub | `server/src/services/tool-gateway.ts:3408-3420` and `:3487`: a connection's header policy `metadata.forward` can forward `company_id`, `agent_id`, `issue_id`, `project_id`, `run_id`, `gateway_session_id` and `correlation_id` as `x-paperclip-*` headers. The default is empty. | The hub needs agent and run identity (tab ownership, concurrency caps, audit). The connection **must** be created with forwarding on, and the hub rejects calls without those headers (PR 6). |
| Why not a REST connector | `doc/connections/CONNECTOR-PLAYBOOK.md:217`: `rest_api` is "not exposed through the connected MCP gateway"; `:2265`: Browser Use's REST path is a reviewed provider adapter | A generic REST connector is not available; copying the Browser Use special-casing touches very large files (`tool-gateway.ts` 11k lines, `tool-access.ts` 20k, `heartbeat.ts` 31k). MCP avoids both. |
| Private endpoints for remote MCP | `server/src/services/tool-access.ts:3269-3274`: private endpoints are allowed unless the deployment is `authenticated` *and* `public`; `server/src/services/remote-http-endpoint-guard.ts:37-98` resolves and pins addresses | A Tailnet hub URL is reachable from the gateway on a private deployment. **To verify in PR 6** against the production exposure setting. The setting is deployment-wide, so this feature inherits that property (section 14). |
| Live relay pattern | `server/src/realtime/environment-custom-image-terminal-ws.ts`: auth token read from the first frame, not the URL (`:251`), 10 s auth timeout (`:116`), URL tokens redacted in logs (`:182`), per-session store and registry | Reuse the pattern (ticket in first frame, session store, company match on upgrade). That file checks the ticket and company match only; **board-role enforcement and member-removal handling must live in our ticket issuance and relay** (PR 5). |
| Plugin system | `doc/plugins/PLUGIN_SPEC.md:432-434`: plugin tools are "available to all agents" by default; `plugin_company_settings`; `packages/plugins/plugin-github` (company-scoped bundled plugin) | A plugin gives company enablement for free but no approval, rate-limit or grant layer for tools, and no bidirectional board relay. Rejected as the primary surface. |
| Feature flags | `packages/shared/src/validators/instance.ts:43-91` (instance experimental flags), `packages/shared/src/feature-catalog.ts`; `packages/db/src/schema/companies.ts:4-33` has **no** per-company flag column | A company-level flag needs a new row. Plan: instance flag plus a `company_browser_settings.enabled` row, both default off. |
| Secrets | `server/src/services/secrets.ts:970` (`secretService`), `packages/db/src/schema/company_secrets.ts`, `secret_access_events.ts`, `doc/SECRETS-AWS-PROVIDER.md` (delete recovery window default 30 days) | Reuse for the profile data key. `recordAccessEvent` writes nothing when no consumer context is passed (`secrets.ts:1186`), so the key read must supply one. Agents have `/agents/me/secrets` and `/agents/me/secret-proposals` routes (`server/src/routes/secrets.ts:194`, `:314`), so the key needs a reserved namespace those routes refuse. **Unverified:** the provider implementations under `server/src/secrets/` could not be read in the session that wrote this plan (permission rule); exact method names are to be confirmed in PR 4. |
| Activity log | `server/src/services/activity-log.ts:217` (`logActivity`) | Reuse for the audit trail. |
| Anti-self-escalation | Open PR #20 (`fix/deny-agent-self-runtime-config`; on GitHub, not in this worktree): `agent.self_config_update_denied`, `requiresChangeGrant` | Follow the same deny-and-log pattern for every profile-admin route. PR #20 is not merged; this plan depends on the pattern, not its code. |
| Agent-owned browser processes | `doc/plans/2026-04-08-agent-browser-process-cleanup-plan.md` (status Proposed) | That plan attributed Chromium accumulation to weak process ownership of local adapter runs; the code has since gained `processGroupId` (`packages/db/src/schema/heartbeat_runs.ts:75`). Either way, hub browsers run in their own containers. A profile that lives only on the hub also means a shell on a worker yields no credentials. |
| Browser tooling already in the repo | `tests/e2e/smoke-lab-browser-runner.mts:29,110` uses Playwright (`chromium.launch`) and merely labels its driver "agent-browser" at `:106`; UI fixtures reference `vercel-labs/agent-browser` as a skill source (`ui/storybook/stories/agent-skill-row.stories.tsx:13`) | Playwright is already a repo dependency (precedent for the fallback executor). agent-browser is not yet used in code here. |
| Container image | `Dockerfile:193` (`ARG INSTALL_LOCAL_CLIS=true`) and `:203` (apt packages: no Chromium); the control-plane build passes `INSTALL_LOCAL_CLIS=false` (`.github/workflows/deploy.yml:50`, `VLLNT.md:87`) | The hub is a separate image; the control-plane image stays unchanged. |
| Jev decision client | Commit `35e5cc1f6` (`feat(server): add Jev judge client over the Vercel AI Gateway`) on branch `feat/decisions-engine-dedup-pr1`, not yet on `main`: `server/src/services/judge-client.ts`, per-company daily cap, content-hash cache, 4 s timeout, never throws | **Reuse, do not build a second client** (PR 7). |

## 3. Options

### 3.1 Executor: who drives Chromium

| Option | License, state | Strengths | Weaknesses | Verdict |
| --- | --- | --- | --- | --- |
| **agent-browser** (native Rust CLI/daemon over CDP) | Apache-2.0; v0.38.1 installed locally; 697 commits | Accessibility snapshot with stable refs, `--content-boundaries`, `--max-output`, persistent `--profile`, shared Chrome via `--cdp` plus `--pin-tab` | Pre-1.0 churn. Large command surface with escape hatches: cookie, eval, state and auth-vault commands; `wait --fn <js>` evaluates JavaScript; `read <url>` fetches from the calling process; `stream` and `dashboard` open listeners; `--allowed-domains` is rejected together with CDP and profiles. One demo shop ignored real clicks that reported "Done" (below) | **Chosen conditionally**: behind a `BrowserExecutor` interface, pinned version and checksum, argv built only from typed fields (section 7), PR 3 gate |
| Playwright persistent context | Apache-2.0; already used for QA in this repo | Stable API, `launchPersistentContext` | "Browsers do not allow launching multiple instances with the same User Data Directory"; `userDataDir` is exclusive; we would rebuild snapshot refs | Fallback executor |
| Playwright MCP | Apache-2.0 | `--user-data-dir`, `--shared-browser-context`, `--allowed-origins` | README: "not a security boundary"; `browser_evaluate` is core and ungated; cookie tools behind `--caps=storage` | Rejected as the agent surface (we need our own boundary) |
| Minimal CDP-direct executor | n/a | Fixed CDP method set, typed arguments, https-only: the smallest attack surface; the hub needs its own CDP client anyway for interception, tab ownership and navigation audit | We rebuild snapshot refs (accessibility tree to node ids), waits, iframes | **Fallback if the agent-browser fence leaks** |

**PR 3 gate.** PR 3 starts with a short, time-boxed spike that implements the tool set against agent-browser with typed argv. If the spike needs more than a handful of argument-level exceptions, or any flag that can run script or fetch, the executor becomes CDP-direct and agent-browser is dropped from the hub. The security boundary must not depend on fencing a large CLI.

Local evidence (agent-browser 0.38.1, headless Chrome, this Mac; checks run by hand against `example.com` and not archived, except the benchmark capture):
- `--profile <dir>` persisted a cookie and a localStorage value across a full close and reopen.
- A second session attached with `--cdp` to the same Chrome read the first session's cookie, so a login is shared live.
- `tab list` from one session shows the other session's tabs, so there is **no isolation by default**; the hub must enforce tab ownership.
- `cookies get` and `eval 'document.cookie'` print raw cookie values, and `get cdp-url` returns a browser-level WebSocket URL that is effectively a bearer token. **An agent with a CLI on the profile can exfiltrate it**, which is why agents never see the CLI.
- Reliability: on one demo shop, two controls (add-to-cart and the cart button) ignored real clicks that returned "Done" (a JS `.click()` worked; a larger viewport and scroll-into-view did not help; cause undetermined). I then used the page's own click for the three remaining shop clicks (checkout, continue, finish) without testing them individually. The 6 other plain clicks in the final capture (checked by snapshot diff) all took effect. The hub therefore verifies each action by diffing the snapshot and reports `effect: none` instead of trusting "Done".

### 3.2 Hosting and profile model

| Option | Where profiles live | Verdict |
| --- | --- | --- |
| **Self-hosted hub, one Chromium per active profile (chosen)** | Sealed blob in Paperclip storage; live copy in RAM-backed storage on the hub | Designed to meet each requirement in section 10; no third party; shared context needs no merge. Sealing and remote sign-in are unproven until the PR 2 and PR 5 spikes. |
| Per-run contexts cloned from a profile snapshot | Snapshot per run | Rejected: sites rotate cookies, so clones diverge and log each other out; write-back needs a merge that does not exist for cookie jars or IndexedDB; cost per run is a cold start. |
| Storage-state export and import (cookies and localStorage JSON) | JSON file | Rejected: a cookie export is the exact thing agents must not be able to do, and it misses IndexedDB and service workers. |
| Hosted vendors (comparison only) | Vendor | Rejected by default. See the table below. |

Hosted comparison (vendor docs read in a research pass and summarised; prices and regions are as published on 2026-10-09 and were **not** re-fetched individually, except the two open-source repositories, which were):

| Vendor | Persistence and export | Human live view | Open source | EU | Main risk of putting login cookies there |
| --- | --- | --- | --- | --- | --- |
| Browserbase | "Context" = Chromium user-data-dir, encrypted at rest; API export not documented | `debuggerUrl` iframe, interactive | No | EU Central; residency details unverified | Cookies sit in vendor storage under vendor-held keys |
| Steel | Session context API returns cookies and localStorage to the key holder; profiles up to 300 MB | `debugUrl` iframe, unauthenticated URL by design | `steel-browser` Apache-2.0, public beta, no documented CDP auth | Not found | The context API hands the raw jar to any API-key holder |
| Kernel | Named profile; `GET /profiles/{id}/download` returns an archive | Live-view URL with token in path | `kernel-images` Apache-2.0 (headful Chromium, noVNC or WebRTC); Docker-volume profile persistence undocumented | `eu-west` (profiles may be processed in the US) | Any API token can download the whole profile |
| Hyperbrowser | Profile snapshot by ID; export not documented | `liveUrl` with a 12 h token | SDKs only | One European region, no residency claim | The live-view token acts as a credential |
| Browser Use Cloud | Profile by `profileId`; Profile Sync uploads local Chrome cookies | `live_view_url` iframe | Library only | On request, Enterprise | Live and CDP URLs give full control; the connector already exists in the repo |

The two open-source stacks (`kernel-images`, `steel-browser`) are useful references for a hub image, but both expose an unauthenticated CDP port by default. Neither is a drop-in.

### 3.3 Integration surface for agents

| Option | Governance reused | Cost | Verdict |
| --- | --- | --- | --- |
| **Hub serves MCP; registered as a remote-MCP connection (chosen)** | Grants, policy, quarantine, approvals, rate limits, audit, runtime delivery to all harnesses (documented; verify in PR 6) | Hub implements an MCP endpoint; no gateway change expected | Chosen |
| First-party connector like Browser Use Cloud | Same | Edits to very large gateway files; vendor-adapter pattern | Rejected |
| Bundled plugin with agent tools | Company enablement only | No approvals, no grants, no board relay | Rejected |
| Core REST API plus `paperclipai browser` CLI and a skill | Activity log only; policy rebuilt | Shell-only, no schema'd tools, awkward images | CLI kept for board and status only |
| Agent shell with `agent-browser --cdp` to the hub | None | Cookie export trivial | **Rejected on security grounds** |

### 3.4 Human sign-in live view

None of these was measured; the cells below are expected behaviour from project docs.

| Option | Fits one HTTPS+WebSocket proxy? | Native popups and dialogs | Clipboard, IME | Notes | Verdict |
| --- | --- | --- | --- | --- | --- |
| **noVNC client + VNC server on headful Chromium in Xvfb** | Yes | Yes (OAuth popups, file pickers) | Text clipboard; IME depends on the server | MPL-2.0 client; server (KasmVNC GPL-2.0, or x11vnc + websockify) runs as a separate process in the hub image | **Chosen**, behind the PR 5 spike |
| CDP `startScreencast` + `Input.*` relay (agent-browser's stream: JPEG `frame`, `input_mouse`, `input_keyboard`, `input_touch`, `tabs`, `url` messages; localhost-only) | Yes | **No** (screencast shows page content only) | Paste via `Input.insertText` only; IME experimental | Cheapest in RAM (headless); we write the canvas and key mapping | Optional later "watch the agent" mode |
| Neko (WebRTC) | **No**: needs a UDP range or TURN beside the proxy | Yes | Yes | Apache-2.0 | Rejected for v1 |
| Selkies 2.0 | Yes (WebSocket mode) | Yes | Yes | 2.0 released 2026-09-23, a three-week-old rewrite | Revisit later |
| DevTools frontend embed | Yes | Partly | n/a | Exposes the Application panel (a cookie viewer) | Rejected |

Headful Chromium also behaves closer to a normal browser, which matters for sites that distrust headless automation. Note that any live view of a normal browser can expose DevTools, the cookie UI and the password manager to the viewer; section 6 disables them by policy.

### 3.5 Where it runs

| Option | Memory headroom | Isolation | Verdict |
| --- | --- | --- | --- |
| **Dedicated small VM on the EU site (chosen)** | Own 8 GiB | Own kernel and firewall; browser containers have no route to the Tailnet or LAN | Recommended |
| Worker container (8 vCPU / 26 GiB, memory about 66-78 % in use) | About 6-9 GiB free; one ad-hoc local measurement of 3 headless tabs summed to about 2 GB RSS over 16 processes (macOS over-counts shared pages; not archived) | Shares a host with agent harnesses that execute arbitrary code | Pilot only, with a hard cgroup limit of 4 GiB; one OOM would kill agent runs |
| Control-plane host | Shared with the database | Holds all company credentials | Rejected |
| Hosted SaaS | n/a | Third party | Needs approval; not recommended |

## 4. Recommended architecture

```
 Board user (browser, Tailnet)                        Agent run (Claude / Codex / Grok on a worker)
        │ HTTPS (session cookie)                                  │ MCP tool call
        ▼                                                         ▼
 ┌──────────────────────── Paperclip server (control plane) ───────────────────────────┐
 │  /api/companies/:id/browser/*  board-only admin (dedicated permission), kill switch │
 │  WS relay  (ticket in first frame, role + company check, Origin check, 1 viewer)    │
 │  tool gateway: grants · Allowed/Ask first/Off · approvals · rate limits · audit     │
 │  secrets: profile DEK (reserved company secret) · sealed snapshots · activity log   │
 └───────────────┬──────────────────────────────────────┬──────────────────────────────┘
                 │ admin API, live-view relay,            │ MCP over HTTPS (per-profile token,
                 │ event pull (server → hub only)         │ agent/run identity headers)
                 ▼                                        ▼
 ┌─────────────────────────── Browser host (dedicated VM, Tailnet inbound only) ───────┐
 │  hub daemon (outside every browser container):                                      │
 │    profile lifecycle · tab ownership · navigation allowlist · redaction · audit     │
 │      │ typed argv / fixed CDP methods                                                │
 │  ┌───▼─────────── one container + network namespace per active profile ───────────┐ │
 │  │ executor ──CDP over pipe / unix socket──► headful Chromium (sandbox ON) + Xvfb  │ │
 │  │ profile workdir on tmpfs          VNC server on a unix socket (other uid)       │ │
 │  │ egress only through a proxy that denies loopback, own IPs, RFC 1918, Tailnet,   │ │
 │  │ link-local and metadata ranges; no TCP listener inside the namespace            │ │
 │  └──────────────────────────────────────────────────────────────────────────────────┘ │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Isolation rules (each has a test in PR 2).**
- One container and network namespace per active profile; the hub daemon runs outside it. Two companies never share a namespace, a loopback interface or a tmpfs.
- Chromium runs with its sandbox on (no `--no-sandbox`), a seccomp profile, and no extra capabilities.
- Nothing inside the browser's namespace listens on TCP. A web page can open WebSocket and HTTP connections to loopback and to its own container's addresses (WebSockets are exempt from CORS), so every control surface is a pipe or a unix socket, or lives outside the namespace. This covers CDP, the VNC server, and any executor `stream` or `dashboard` listener (disabled).
- Egress goes through a proxy that denies loopback, the container's and host's own addresses, RFC 1918, the Tailnet range, link-local and metadata ranges.
- A probe test serves a page that tries every listener and port in its namespace and must find none.

Three flows:
1. **Sign in.** Board user opens the profile → server checks the dedicated permission and company → server asks the hub to activate the profile (decrypt snapshot into tmpfs, start the container, set state `signing_in`; drain agent calls; blank agent tabs; open a fresh tab for the human) → server issues a one-time ticket → UI opens the WebSocket and sends the ticket in its first frame → server relays VNC bytes. On close the hub marks the profile `ready` and later seals it.
2. **Agent action.** Agent calls `browser_open` through its normal MCP path → gateway applies grant and policy and forwards agent and run identity → hub resolves token → profile → checks state, allowlist, caps → allocates an owned tab handle → runs the typed command → redacts and size-caps the result → returns it. Audit events are queued on the hub and **pulled** by the server (the hub never initiates a connection to the control plane).
3. **Revoke.** Board user presses Suspend or Destroy → server marks the profile, revokes the connection grant (a scoped grant revoke is checked on every call), and pushes the command to the hub with retry and acknowledgement → hub aborts in-flight calls, closes the viewer, kills the container, wipes tmpfs, drops tokens. If the hub is unreachable, the hub **self-suspends after 30 s without an authenticated server heartbeat** (dead-man timer). Destroy also deletes the sealed snapshots and the data key.

## 5. Persistent, shared sessions

**Profile.** One row per `(company, profile)`; unique name per company; fields include status, allowed domains (host, optionally path prefixes), feature toggles (screenshots off by default; downloads, uploads off), tab caps, and the generation of the latest sealed snapshot. A profile never belongs to two companies; every query and every hub call carries the company id and the hub rejects a mismatch.

**States.** `empty → signing_in → ready → (suspended | destroyed)`; `ready ↔ active` when a browser is running. `signing_in` holds an exclusive lease: agent tools return `profile_busy` until the human closes the view or the lease expires. Taking the lease drains in-flight calls (they fail with `profile_busy`), sends agent tabs to `about:blank`, and gives the human a fresh tab, so a hostile page cannot spoof a login prompt in a tab the human did not open.

**Concurrency.**
- One Chromium process per profile. Chromium's own single-instance lock on the user-data-dir stops a second writer; Playwright documents the same rule.
- One shared default context, so cookies set by one agent are visible to the others immediately.
- Each agent run gets tab handles (opaque IDs). A handle works only for its owning run (identity from the forwarded headers); `tab list` is filtered. Defaults: 4 tabs per run, 8 per profile, 3 concurrent runs per profile; excess calls queue for a short time and then return `profile_busy`.
- Same-site races (two agents submitting the same form, or one logging the other out) cannot be prevented generically. Mitigations: tool profiles let the board give most agents read-only tools; navigation to common logout paths is blocked unless the profile allows it; an optional per-origin write mutex is a v2 item.

**Write-back and at-rest encryption.**
- The live profile directory sits on tmpfs, so plaintext never reaches the VM's disk. The HTTP cache is discarded (separate cache directory, small quota). Cap per profile is configurable (default 512 MiB).
- Canonical copy = a sealed archive: AES-256-GCM, a random per-profile data key, a nonce per chunk, and additional authenticated data = company id + profile id + generation, so a blob cannot be swapped between profiles or companies.
- The data key is stored as a **company secret** through the existing secret service, so the instance's configured provider protects it. It uses a **reserved key namespace** that agent secret routes, proposals and catalog listings refuse to read, bind or propose, and the key read passes a consumer context so `secret_access_events` records it. The server hands the key to the hub at activation over the authenticated admin channel; the hub keeps it in memory only and zeroes it on suspend and destroy.
- Destroy deletes the key with the provider's strongest delete. With the AWS provider the default recovery window is 30 days (`PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS`), so Destroy is only irreversible after that window unless a forced delete is available; the UI says so. Sealed snapshots are deleted at once and are undecryptable without the key.
- Chromium on Linux without a keyring falls back to a fixed key for its own cookie encryption (`--password-store=basic`), so Chromium's built-in encryption is not a control here. This is known behaviour to confirm in the hub spike.
- Sealing happens on graceful idle shutdown (default: 10 minutes without agent or human activity) and on suspend. Three generations are kept. Periodic checkpoints while active are best-effort and gated on a consistency check in the spike; until then the loss window after a hub crash is "changes since the last seal".
- Hub reboot or crash: the tmpfs copy is gone; the next activation restores the last sealed generation. Sessions may need a fresh sign-in. The health monitor (section 8) reports it.

## 6. Human sign-in (live view)

- **Access.** A dedicated board permission (working name `browser:manage`, defined in PR 1; `tools:admin` guards the generic tool routes today and is broader than needed here) in the same company. Agents get 403 at ticket issuance and an audit row. The ticket is a one-time value, 30 s lifetime, bound to user, company and profile. The client sends it in the **first WebSocket frame**, never in the URL (pattern: `environment-custom-image-terminal-ws.ts:251`). The relay checks the `Origin` header and closes the connection when the user's membership or permission is removed, not only on ticket expiry.
- **Transport.** Browser → Paperclip server (HTTPS, Tailnet) → hub (private link) → VNC server on a unix socket inside the profile's container. The user's browser never talks to the hub.
- **Human-viewer hardening.** A live view of a normal browser would let a board user read the session through the browser itself. The profile's Chromium therefore runs in kiosk mode with enterprise policies: `DeveloperToolsAvailability=2`, `URLBlocklist` for `chrome://*` and other internal schemes, `PasswordManagerEnabled=false`, `BrowserSignin=0`, sync disabled, extension installs blocked. This does not stop a viewer from using the signed-in session as themselves (that is the point), only from lifting the cookie jar out of it.
- **Lease.** One interactive viewer per profile; others can be view-only or refused. Idle timeout and maximum duration apply. Every session records user, start, end and the navigations performed.
- **Limits to state plainly.** The user's own password manager cannot autofill into a remote view (they type or paste via the clipboard control); passkeys and hardware keys do not work; some identity providers refuse automated or remote browsers. Headful Chromium with a minimal automation footprint during sign-in mitigates the last point; it is a spike item with sites the operator names.
- **Spike acceptance (PR 5, before building the UI).** Input-to-frame latency under 150 ms on the Tailnet; text paste works; a TOTP code can be typed; an OAuth popup is reachable; the policies above are in force (F12, `chrome://settings/cookies` and the password manager are blocked); works through the Paperclip relay on a single HTTPS port; desktop and mobile viewport checks with zero console errors.

## 7. Agent interface

**Tool surface (MCP, served by the hub).**

| Class | Tools |
| --- | --- |
| Read | `browser_status`, `browser_snapshot` (accessibility tree with refs; content-boundary markers; size-capped; values of password, one-time-code and token-like fields redacted), `browser_screenshot` (JPEG, size-capped; **off by default per profile**), `browser_read` (text of the current tab), `browser_assess` (state classifier, section 8) |
| Write | `browser_open` (allowlisted navigation in the caller's tab), `browser_click`, `browser_fill`, `browser_press`, `browser_select`, `browser_scroll`, `browser_wait` (milliseconds, load state or element only; never a script), `browser_close_tab`, `browser_request_signin` |

**Typed arguments only.** The hub builds the executor's argv from validated fields. No agent-supplied string becomes a flag or a subcommand: refs match `^e[0-9]+$`, keys come from an enum, durations are integers, and free text (fill values) is passed after `--`. URLs must parse, use `https` (plain `http` only if the profile allows it), carry no userinfo, and match the allowlist by exact parsed hostname (or an explicit suffix rule); `javascript:`, `data:`, `blob:`, `file:`, `view-source:`, `chrome:` and every other scheme except `about:blank` are refused. Redirects and popups are checked against the same allowlist. A fuzz test feeds every tool input leading dashes, `--`, whitespace and URL tricks such as `allowed.com@evil.com`.

**Page-borne secrets.** `browser_fill` refuses `type=password` and one-time-code fields, so secrets are never typed by an agent. Tool results strip query strings and fragments from URLs (OAuth callbacks carry tokens). Screenshots are not redacted, hence off by default. **Residual risk, stated plainly:** a credential that is *displayed* on an allowlisted page (an API key, a recovery code) is readable by the agent and its model provider. The board limits this with path-level allowlists and by not granting such pages.

**Deliberately absent** (asserted absent by a test that enumerates the hub's tool list, the executor's subcommands and their argument schemas): cookies, storage, state save/load, eval and arbitrary scripts (including `wait --fn`), `read <url>`, network route/HAR, the auth vault, `connect`/`cdp-url`/`profiles`, `stream` and `dashboard`, extensions, init scripts, clipboard, downloads and uploads (opt-in later), profile switching.

**Harnesses.** Claude, Codex and Grok receive the tools the same way as other connection tools, through the runtime MCP delivery and the native and CLI bridges (`doc/MCP-RUNTIME-OPERATIONS.md:16-35`; `doc/connections/BROWSER-USE.md`, "Runtime and lifecycle"). What differs per harness is unverified: whether image results (screenshots) render, and result-size limits. PR 6 includes one live run per harness reading a snapshot and, where enabled, a screenshot; fallback is a text description plus an artifact link.

**Registration.** PR 6 creates the connection through the existing remote-MCP path with a header policy that forwards `agent_id`, `run_id` and `correlation_id` (the correlation id also joins gateway audit rows to hub events). The server mints and rotates the per-profile token and stores it as a company secret; a thin server helper calls the existing API so operators do not hand-write headers. The hub rejects calls that lack the identity headers. If the helper cannot stay within existing extension points of `tool-access.ts`, that is flagged in the PR rather than widened silently.

**CLI.** `paperclipai browser profiles|status|signin-link` for board users; read-only status for agents. No command can read profile contents.

## 8. Jev as a fast decision step (measured)

**What Jev is.** `typesafe-ai/jev` on the Vercel AI Gateway is a "decision" model: state in, typed answers out (choice with probabilities, score, boolean probability), no free text. $0.042 per million input tokens, output free; 64k token request limit, 32k for `state`; Zero Data Retention and No Training can be requested per call (Vercel guide, `vercel.com/kb/guide/typesafe-jev-and-ai-sdk`).

**Setup.** 30 labelled steps from 3 flows on public automation-practice sites: a shop sign-in and checkout (12 steps), a login with a failed first attempt and logout (8), and hard states: a reCAPTCHA page, a 503 page, a 404 page, a locked-out account and a todo app (10). Every model saw the same input: goal, URL, title, accessibility snapshot (average about 900 characters) and 1-4 page elements as candidate actions plus "stop" and "hand off" (3-6 options). Four questions: page state (5-way), next action (3-6-way), goal done, needs a human. Sequential calls through the AI Gateway on 2026-10-09; Jev was called twice per step. Reproduce with the scripts in the evidence directory.

| Model | Valid / 30 | Page state | Next action | Goal done | Needs human | Latency p50 / p95 | $ per step | Input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Jev** (pass 1) | 30 | 30 | 25 | 28 | 29 | 281 / 359 ms | 0.000041 | 976 |
| Jev (pass 2) | 30 | 29 | 25 | 28 | 29 | 278 / 363 ms | 0.000041 | 976 |
| Sonnet 5 | 30 | 30 | 29 | 29 | 29 | 1255 / 5063 ms | 0.00254 | 879 |
| Haiku 4.5 | 28 (2 unparsable) | 28 / 28 | 26 / 28 | 26 / 28 | 27 / 28 | 759 / 1076 ms | 0.00091 | 682 |

Read with care.
- **Small sample.** n = 30; the 95 % Wilson interval for Jev's 25/30 next-action accuracy is about 66-93 %, for Sonnet's 29/30 about 83-99 %. Differences of one or two steps are noise.
- **Public practice sites, not the operator's services.** No real account was used. The snapshots here are small; real dashboards will likely produce much larger ones (not measured), so cost and latency will be higher, and Jev's 32k-token state limit means snapshots must be capped.
- **Two caveats.** One shared miss (`practice-login-retry#8`) is a labelling ambiguity: the page after logout looks like a fresh login form, and the state carried no history. The router figures below were chosen post hoc among three thresholds on the same 30 steps and are illustrative only.
- **Baselines.** The gateway team's model allowlist returned HTTP 403 for Sonnet 5.5 and Haiku 5.5, so the newest permitted Sonnet (5) and Haiku (4.5) were used. The benchmark used `ai@7.0.127` and `experimental_evaluate`; `ai@7.0.136` (which the judge client pins, with `experimental_decide`) was blocked by the npm release-age policy, and that guard was not overridden.

**Where Jev missed (next action, 5 of 30).**
- Two low-confidence picks (0.68 and 0.52): it chose to re-fill the password field instead of clicking Login after both fields were filled. Both LLMs were right.
- Two hand-off decisions that both LLMs got right: on the CAPTCHA page it chose "click Submit" with confidence **0.89**, and on the locked-account banner it chose "dismiss error" (0.56). The 0.9 threshold in the router table below excludes the CAPTCHA miss only narrowly.
- One shared miss (`practice-login-retry#8`, hand-off vs stop) that all three models got wrong; the state carried no history.

Jev's own classifiers were right on both hand-off steps (page state `captcha`; needs-human at or above 0.5). A **rule-driven hand-off** (`page_state = captcha` or `needs_human >= 0.5` → hand off, regardless of the chooser) lifts Jev's next-action score from 25/30 to 26/30 on this data: it fixes both hand-off misses and breaks one step (a plain login form where needs-human was 0.57). That is a post-hoc check on the same 30 steps, so it supports the design (hand-off comes from the classifier, never from the chooser) without proving a threshold. Page-state accuracy was 30/30 and 29/30 across the two passes.

**Confidence-gated router** (Jev answers if its choice confidence is at least tau, else Sonnet 5):

| tau | Jev answers | Jev right on those | Sent to Sonnet | Combined accuracy | Cost vs Sonnet-only |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 28 / 30 | 23 / 28 | 2 | 25 / 30 | -85 % |
| 0.7 | 24 / 30 | 22 / 24 | 6 | 28 / 30 | -74 % |
| 0.9 | 17 / 30 | 17 / 17 | 13 | 29 / 30 | -45 % |

Cost is the recorded per-call dollars of 30 Jev calls plus the routed Sonnet calls, against $0.0763 for Sonnet on all 30 steps; routed steps cost more than the Sonnet average. It ignores that routed steps pay both latencies.

**Plan for Jev.** Keep it to what it does well and put an LLM behind the rest.
1. **Page-state classifier** (`signed_in / signed_out / captcha / error / other`) and **needs-human** detector after each navigation, and a **profile health monitor** that checks a profile's landing pages every N minutes and flips the profile to "needs sign-in" before an agent trips over an expired session. This is the best fit: cheap, fast, and tolerant of one wrong answer.
2. **Confidence-gated action chooser** among candidates the hub proposes, with tau of at least 0.9 and an LLM fallback. Hand-off is decided by rule from the classifiers (`captcha` or needs-human at or above 0.5), and "stop" decisions go to the LLM.
3. **Never** for typing values, extracting numbers, planning, or anything free-form.
4. **Data handling.** Snapshots sent to Jev leave Paperclip's control and are processed by the model provider (a probe call's gateway routing metadata named the TypeSafe provider with one fallback provider; not stored in `results.json`). Therefore: off by default, an explicit per-company opt-in, Zero Data Retention requested, a minimised input (no input values, query strings stripped, text truncated), and the existing per-company daily call cap. The agent's own LLM already sees the same page content, so this adds a processor, not a new kind of exposure. **This needs the operator's approval** (section 14).
5. **Reuse.** The server asks the existing `judge-client` (so the gateway key and the daily cap stay on the server); the hub never holds the key. PR 7 depends on the branch carrying that client merging.
6. **Optional.** None of the ten security requirements needs Jev. PR 7 is last in the feature path, independent of PRs 1-6 and 8, and can be dropped without changing anything else.

## 9. Where it runs and infra requests

The hub is operator infrastructure. Exact asks:

1. **A browser host.** Dedicated VM on the EU site: 4 vCPU, 8 GiB RAM, 40 GiB disk, no swap (or encrypted swap), Debian or Ubuntu LTS, a container runtime that supports user namespaces and seccomp profiles (so Chromium's sandbox stays on), full-disk encryption. Sizing is an estimate: one ad-hoc local measurement of 3 headless tabs summed to about 2 GB RSS, so 8 GiB covers a few concurrent profiles; confirm by measuring on Linux in PR 2.
2. **Network.** The VM joins the Tailnet with its own tag. Inbound: only the Paperclip server may reach the hub port (admin API, MCP and live-view relay on one HTTPS port); nothing from workers. The hub **never initiates connections to the control plane** (the server pulls events and sends heartbeats). Browser containers have no route to the Tailnet or LAN: their only egress is the filtering proxy, which denies loopback, own addresses, RFC 1918, the Tailnet CGNAT range, link-local and cloud-metadata ranges. No public ingress, no Funnel.
3. **Secrets.** One hub admin token (server ↔ hub) and TLS for the hub port. Provided as server environment variables whose values never enter the repository; names will be fixed in PR 4.
4. **Control plane.** The new flag stays off until the hub exists; optional: object-storage or disk quota for sealed snapshots (tens to hundreds of MB per profile).
5. **Gateway.** Nothing new for the hub. For re-running the benchmark with newer baselines, the gateway team's model allowlist currently blocks Sonnet 5.5 and Haiku 5.5.
6. **Observability (optional).** Scrape the hub's health and memory metrics; alert on tmpfs fill and OOM kills.

Pilot fallback, if a VM is not approved yet: run the hub on a worker with a 4 GiB memory limit and a CPU limit, accepting shared-host risk and keeping the same per-profile container rules. The same image and flows apply.

## 10. Security model

The profile is credentials. Everything below follows from that.

### 10.1 Trust boundaries and assets

| Asset | Where it lives | Who may read it |
| --- | --- | --- |
| Cookies, storage, IndexedDB (the profile) | tmpfs in the profile's container while active; sealed blob at rest | The profile's Chromium and the hub process |
| Profile data key | Reserved company secret; hub memory while active | Server (via secret service, audited); hub |
| Hub admin token | Server environment; hub environment | Server and hub |
| Per-profile MCP token | Company secret (connection credential) | Gateway; hub (to authenticate) |
| Live-view ticket | Server memory, 30 s | The board user who requested it |
| Page content in tool results | Agent's model context | The agent and its model provider (inherent) |

Trusted: the hub VM and its operator (a root user on the hub can read RAM). Untrusted: every web page, every agent (assume prompt-injected), other companies, and the Chromium renderer (a renderer bug must not reach another company's profile, hence one container per profile with the sandbox on).

### 10.2 Requirement → control → test

| Requirement | Control | Test (in the PR named) |
| --- | --- | --- |
| Company-scoped, never shared across companies | `company_id` on every row and every hub call; hub rejects a mismatch; one container and namespace per profile; AAD binds sealed blobs to company and profile; MCP token maps to one profile | PR 4: cross-company access returns 404/403; PR 2: a blob sealed for company A fails to open for company B; two profiles share no namespace, tmpfs or socket |
| Encrypted at rest with the instance secret mechanism | Sealed archives with a per-profile data key held as a reserved company secret; tmpfs for the live copy | PR 2: tamper and wrong-AAD tests; PR 4: key read creates an access event; agent secret routes refuse the reserved namespace |
| Tailnet-only, no public endpoints | Hub reachable only from the control plane; hub never dials out to it; browser containers have no Tailnet or LAN route; no Funnel; the user's browser never contacts the hub | PR 2: hub refuses non-allowlisted callers; namespace probe test; PR 8 runbook check |
| Board-only sign-in and live view | Ticket issuance requires the dedicated board permission in that company; agent tokens get 403 plus an audit row; Origin check; closes on membership removal | PR 5: agent, other-company user, user without the permission, and expired or reused ticket all rejected; removing the permission closes an open session |
| Per-profile agent allowlist | One remote-MCP connection per profile; agents reach it only through grants and tool profiles that need `tools:admin` to change; hub rejects calls without forwarded identity | PR 6: ungranted agent gets no tools; revoked grant stops calls; call without identity headers rejected |
| Audit log (who, when, which domains and actions) | Gateway audit rows plus hub events pulled by the server and written with `logActivity`; fields are actor, run, correlation id, profile, tool, host, outcome, duration; **every committed navigation** (from `Page.frameNavigated`, including redirects, popups and click-driven loads) is logged with host and path, never query, typed text or page content | PR 4/6: events exist for sign-in, each tool class, denial and revoke; a redirect to another host appears |
| Agents cannot export cookies or storage | No cookie, storage, state, eval, CDP or shell tools; typed argv with no agent-supplied flags; no `wait --fn`, `read <url>`, `stream`, `dashboard`; the executor runs inside the profile's container with no reachable listeners; navigation allowlist incl. scheme and userinfo rules; password fields not fillable; URLs in results stripped of query and fragment | PR 3: enumeration test of tools, subcommands and argument schemas; fuzz test of tool inputs; navigation to a non-allowlisted origin (by redirect and popup too) is refused; PR 2: namespace probe |
| No secrets typed into prompts | `browser_fill` refuses password and one-time-code fields; snapshots redact their values; humans sign in through the live view | PR 3 |
| Respect anti-self-escalation (#20) | Profile, allowlist and viewer-permission mutation are board-only under `browser:manage`; tool grants and profile bindings need `tools:admin` (`server/src/routes/tool-gateway.ts:378`); an agent actor gets 403 plus `browser.profile_denied`, including an agent trying to bind the connection to itself or to read or propose the data key | PR 4 negative tests; PR 6: an agent token cannot create or modify grants, bindings or the connection |
| Kill switch (instant) | Suspend (reversible) and Destroy (deletes snapshots and data key, typed confirmation). Server revokes the scoped grant (checked per call), pushes suspend with retry and ack; hub checks profile state on **every action**, aborts in-flight calls, closes the viewer, kills the container, wipes tmpfs; dead-man timer self-suspends the hub after 30 s without a server heartbeat; instance flag off rejects everything | PR 4/8: revoke during an in-flight `browser_wait` aborts it; hub unreachable during Suspend still ends in a suspended profile within 30 s; next call after revoke is refused |

### 10.3 Threats worth naming

- **Malicious page reaching control surfaces.** A page can open WebSocket and HTTP connections to loopback and to its container's addresses. Mitigation: no TCP listener inside the browser's namespace, unix sockets and pipes only, egress proxy denies loopback and own addresses, sandbox on, one container per profile so a renderer escape reaches one profile at most.
- **Prompt injection from a page.** Page text may tell the agent to act. Controls: content-boundary markers; default tool profile is read-only; write tools start off under the generic remote-MCP rules; navigation allowlist; audit. Residual: an authorised agent can still be steered into in-app actions on an allowlisted site (for example creating a public share link) if the board grants write tools.
- **Cookies for more domains than agents may visit.** Signing in through an identity provider stores IdP cookies. The agent's navigation allowlist is per profile, so agents cannot visit the IdP unless the board allows it.
- **Credentialed requests to other sites from an allowlisted page.** A page, an ad or user-generated content on an allowlisted site can fire sub-requests or form posts to other sites where the jar is signed in. The allowlist covers top-level navigation and popups, not sub-resources (strict sub-resource allowlists break modern sites). Hardening to evaluate in the spike: `BlockThirdPartyCookies` and SameSite-by-default in agent mode, relaxed only during human sign-in (it may break embedded SSO; switching modes restarts the browser).
- **Page-borne secrets.** Section 7: residual and stated.
- **Hub compromise.** An attacker on the hub reads live profiles. Mitigations: dedicated VM, inbound-only-from-control-plane, no agents or shells on it, image from a pinned build, short-lived workdir.
- **Board users and the live view.** Handled by policy hardening (section 6) and the dedicated permission. A viewer can still act as themselves in the session.
- **Screenshots and text go to the agent's model provider.** Inherent to any browsing tool; screenshots are off by default and the board controls them per profile and per tool profile.
- **Passkeys and hardware keys** are unsupported; do not work around them with cookie import.

## 11. Feature flag and rollout

There is no per-company feature flag today (`companies.ts:4-33`); existing flags are instance-level (`instance.ts:43-91`). Plan:
- **Instance flag** `enableSharedBrowser` in `instanceExperimentalSettingsSchema`, default `false`, with a feature-catalog entry (tier `managed`, defaults match; a test enforces this).
- **Company opt-in** `company_browser_settings.enabled`, default `false`, plus per-company limits (profiles, tabs, concurrent runs, Jev opt-in). Both must be true for any route, tool or WebSocket to work; otherwise they return 404.
- Rollout: dark everywhere → hub deployed → one company (dogfood) → others on request.

## 12. PR breakdown

Each PR is small, behind the flag, adds tests, passes typecheck, and is pushed with `git -c core.hooksPath=.githooks push`.

| PR | Scope | Key tests |
| --- | --- | --- |
| 1. Contracts and flag | `packages/shared` types and zod validators (profile, status, allowed domains, tool names, audit event names, the `browser:manage` permission); `packages/db` tables `browser_profiles`, `company_browser_settings`, `browser_signin_sessions` plus migration; instance flag and catalog entry; activity-format labels | Validators; migration applies; catalog and schema defaults agree; both flags off → 404 |
| 2. Hub core | `packages/browser-hub` daemon and `docker/browser-hub` image: per-profile container and namespace, tmpfs workdir, Chromium with sandbox on, sealing and unsealing, health, admin API with hub token, event queue for pull, dead-man timer | Seal/unseal, tamper and AAD tests; lifecycle with a fake Chromium; namespace probe test; one real headless Chromium test where available; measure memory on Linux |
| 3. Hub executor and tools | Spike gate (agent-browser vs CDP-direct); `BrowserExecutor` interface; typed argv builders; tab ownership; navigation allowlist and navigation audit via CDP; redaction; post-action effect check; tool definitions and handlers (transport comes in PR 6) | Enumeration of tools, subcommands and argument schemas (no cookie, storage, eval, state, `wait --fn`, `read`); input fuzz; tab isolation between two runs; non-allowlisted navigation refused (redirect, popup, scheme, userinfo); password field refusal; `effect: none` reporting |
| 4. Server admin and kill switch | Board-only routes under `/api/companies/:id/browser/*` with `browser:manage`; hub client (push with ack, event pull, heartbeat); data key through the secret service in a reserved namespace with a consumer context; Suspend and Destroy; company settings; `logActivity` events; deny-and-log for agent actors | Embedded-Postgres route tests with a fake hub: cross-company, agent actor 403 plus audit, reserved-namespace refusal, key access event, revoke ordering, hub-unreachable path |
| 5. Live view | Spike first (latency, paste, TOTP, OAuth popup, hardening policies); server WebSocket relay with one-time ticket in the first frame, Origin check, viewer lease, idle and max-duration limits, close on permission removal, lease drain; UI profile page with the noVNC canvas | Ticket expiry, reuse, wrong company, agent token, missing permission, second viewer, permission removal; component tests; real-browser check at desktop and mobile widths with zero console errors |
| 6. Agent integration | Serve the PR 3 tools as an MCP endpoint with per-profile tokens; helper that creates the connection with identity forwarding on; token mint and rotation; risk classes and annotations; skill text; `paperclipai browser` status commands; one live run each for Claude, Codex and Grok | Gateway test with a fake hub: grant, policy, Ask first, revoke, audit, identity headers required; negative: ungranted agent, agent cannot edit grants; private-endpoint check against the production exposure |
| 7. Jev decision step (optional) | Reuse `judge-client`; `browser_assess` and the health monitor; per-company opt-in; minimised input; ZDR; LLM fallback | Injected-transport tests; fallback on timeout, cap and refusal; live smoke gated by an environment variable |
| 8. Dogfood and runbook | `doc/browser/SHARED-BROWSER.md` (operator and board runbook), acceptance script, alerts; live acceptance on the dogfood company | Acceptance checklist below |

## 13. Verification and dogfood

- **Automated:** per PR as above, plus the repository's targeted checks (`pnpm test:run` for touched suites, `pnpm -r typecheck` or the documented local equivalents, `pnpm check:token-gates` for UI).
- **Security gates before any real login:** the enumeration and fuzz tests, namespace probe, cross-company test, agent-denial test, sealing tamper test, reserved-secret test, and a manual attempt to read a cookie through every agent-reachable path.
- **Live acceptance (PR 8):** sign in once through the live view (with 2FA); two agents read pages concurrently in separate tabs; restart the hub and confirm the session survives from the sealed snapshot or fails safe with a sign-in request; revoke mid-run and confirm the next call is refused and the in-flight call aborts; confirm audit rows for each step, including a redirect.
- **First dogfood target:** the anthm QA agent reading PostHog dashboards through a shared profile with read-only tools, screenshots off unless needed, and a PostHog-only navigation allowlist. Note `doc/connections/POSTHOG.md`: PostHog already has a first-party MCP connection (OAuth or personal API key). If the QA gap is only a missing key or scope, that is a faster fix than a browser; the browser remains the right tool for services without an API. See section 14.

## 14. Risks, open questions, and decisions for the operator

**Decisions needed (nothing below is assumed approved).**
1. **Third-party processing of page snapshots by Jev** (via the Vercel AI Gateway and its model provider). Recommended: off by default, per-company opt-in, ZDR, minimised input. Alternatives: LLM-only, no new processor; or drop PR 7 (no requirement depends on it).
2. **A dedicated browser VM** (4 vCPU / 8 GiB / 40 GiB, EU site, Tailnet-only). Recommended. Alternative: pilot on a worker with a 4 GiB cap and the same per-profile container rules.
3. **No hosted browser vendor.** Recommended and assumed; say so if you want one evaluated.
4. **Security weakening:** none is proposed. Things that would weaken it and are *not* recommended: write tools enabled by default; screenshots on by default; importing cookies from a person's browser; sub-resource-level allowlists as the only control; working around passkeys; running Chromium with `--no-sandbox`; sharing a container between companies.
5. **Dogfood target.** Keep PostHog through the browser, or first try the existing PostHog MCP connection with a query-scoped key (faster), keeping the browser for a service without an API?
6. **Live view technology.** VNC-class recommended, with a spike gate; screencast relay is the fallback or later "watch" mode. No action unless you prefer otherwise.
7. **Licensing of the hub image.** The VNC server options are GPL (KasmVNC, x11vnc) and run as separate processes in an operator-built image, not inside the Paperclip image. Confirm that is acceptable.
8. **Dedicated permission.** `browser:manage` is a new board permission (PR 1). Alternative: reuse `tools:admin`, which is broader than needed.

**Risks.**
- agent-browser is pre-1.0, has argument-level escape hatches, and one site ignored its real clicks; mitigated by typed argv, the executor interface, effect verification, a Playwright fallback and the PR 3 gate to switch to CDP-direct.
- Per-profile containers raise memory and ops cost; the 8 GiB sizing is an estimate until measured on Linux.
- Cookie-jar consistency when sealing a running profile is unproven; v1 seals on graceful shutdown only.
- Some identity providers may refuse the remote headful browser; needs a spike with the operator's real services.
- `allowPrivateRemoteEndpoints()` must be true on production (`tool-access.ts:3269`) for the gateway to reach a Tailnet hub. It is deployment-wide, so any board user who can create remote MCP connections can point them at any Tailnet address; this feature depends on that existing property and does not widen it.
- Secrets provider internals, header forwarding in the generic remote-MCP UI, and the gateway behaviour for a non-vendor MCP server were read from documentation or code excerpts, not exercised; each is an explicit check in PR 4 or PR 6.
- PR 7 depends on the branch carrying `judge-client` merging.

## 15. Evidence index

Repository (file:line, as read on 2026-10-09 at `3ae19ee8f`): section 2, except the judge-client (commit `35e5cc1f6` on `feat/decisions-engine-dedup-pr1`) and PR #20 (GitHub, open).
Local experiments: agent-browser 0.38.1 on macOS; the Jev benchmark capture and results are in `2026-10-09-shared-browser-jev/`; the persistence, CDP sharing, cookie-readability and memory checks in sections 3.1 and 3.5 were run by hand and are not archived.
External:
- agent-browser: https://github.com/vercel-labs/agent-browser (Apache-2.0; streaming, trust-boundary and `wait`/`read` behaviour from `agent-browser <command> --help` and the bundled `skills get core` references)
- Jev and AI SDK: https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk, https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
- Chrome 136 remote-debugging restriction: https://developer.chrome.com/blog/remote-debugging-port
- Playwright persistent context: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Self-hostable references: https://github.com/kernel/kernel-images, https://github.com/steel-dev/steel-browser (both Apache-2.0, verified)
- Hosted vendors (read in a research pass, not re-fetched individually): https://docs.browserbase.com/features/contexts, https://docs.steel.dev/overview/sessions-api/reusing-auth-context, https://www.kernel.sh/docs/browsers/profiles, https://hyperbrowser.ai/docs/sessions/profiles, https://docs.browser-use.com/cloud/browser/live-preview
- Live view: https://github.com/novnc/noVNC, https://github.com/kasmtech/KasmVNC, https://neko.m1k1o.net/docs/v3/configuration/webrtc, https://github.com/selkies-project/selkies/releases
- CDP controls: no per-method CDP filter exists in Chromium; `RemoteDebuggingAllowed` is all-or-nothing (Chromium policy templates); `--remote-allow-origins` checks only the browser `Origin` header. Hence the hub, not the agent, owns every CDP connection.

## 16. Phase 0 review log

Two independent reviews ran on the first draft (a security review and a fact-check of citations and numbers). Changes made:
- **Security review.** Added per-profile container and namespace isolation, sandbox-on and no-listener rules (a page can reach loopback WebSockets); typed argv and URL rules, because `wait --fn` and `read <url>` bypassed the subcommand allowlist, plus the PR 3 gate to CDP-direct; screenshots off by default and URL stripping for page-borne secrets; a pull-based event channel, per-action state check and dead-man timer for the kill switch; mandatory identity-header forwarding; viewer hardening policies and a dedicated permission; lease drain; a reserved secret namespace and honest Destroy semantics; navigation audit; relay Origin and membership checks. Not adopted: dropping Jev and the comparison tables outright. Jev is kept as measured, optional work because the operator asked for the prototype; the comparison tables are an explicit deliverable.
- **Fact-check.** Corrected the router cost reductions (they had priced routed calls at the mean; recomputed to -85 / -74 / -45 %); removed a false claim that the smoke-lab runner uses agent-browser (it uses Playwright); fixed the Dockerfile and file-size citations and two line ranges; softened statements that rested on documentation (gateway reuse, VNC behaviour, "meets every requirement", Jev "matches"); stated that unarchived local checks are unarchived.
- **Still unverified and carried as explicit checks:** secrets provider internals (unreadable here), generic remote-MCP header policy in the UI, production deployment exposure, per-harness screenshot support, VNC latency and clipboard, cookie-jar sealing consistency, Linux memory use.

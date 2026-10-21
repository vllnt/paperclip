# OpenShell evaluation: a sandbox runtime under Paperclip, linked to Policies

Status: decision document, 2026-10-21. Research only. No implementation starts
without the user's go on the recommended option.

## Summary

- **What it is.** NVIDIA OpenShell (Apache-2.0, Rust, v0.1.5) runs each agent in
  a sandbox and enforces a YAML policy. Linux kernel features (Landlock and
  seccomp) confine files and processes, and a supervisor proxy checks every
  outbound connection, down to the HTTP method and path. It also keeps real
  credentials out of the sandbox.
- **Where it fits.** Paperclip already has the right seam: a sandbox-provider
  plugin, the same kind Daytona uses.
  - An OpenShell provider needs no change to the core provider interface.
    Shipping it still needs a bundled-plugin registration and an OpenShell
    client in the app image.
  - Eight adapters plus the native runner can use it.
  - An open upstream pull request already drafts it.
  - Low-trust runs already require a sandbox driver.
- **What it adds.** Today Paperclip's guardrails act mostly on its own HTTP API.
  Inside provider sandboxes it enforces no filesystem, L7 or credential policy.
  Its only network enforcement there is host-level egress filtering on the
  Kubernetes provider. OpenShell would add all of these.
- **Policies link.** A later, separate "controls" part of a policy could
  compile into an OpenShell policy per run, with the strictest rule winning.
  **Policies slice 1 needs no schema hook.** The owner of the Policies work has
  been told which four invariants to keep.
- **Risks.**
  - It is about eight months old (the repository was created on 2026-02-24).
  - 0.1.0 broke deployments, policies and APIs, and introduced new isolation
    primitives.
  - Six CVEs were fixed in April 2026, two of them critical. That fix predates
    the 0.1.x isolation code.
  - Two unsafe defaults must always be overridden: Landlock `best_effort` and
    L7 `audit`.
  - Per-sandbox footprint and latency are not published.
  - It needs Linux 6.2+ and a container runtime (Docker, rootless Podman or
    Kubernetes) or KVM, so it cannot run inside the production app container.
- **Recommendation: Option B.** Make OpenShell an opt-in sandbox provider that
  policies can require, starting with low-trust work. Gate it on a spike on a
  non-production Linux host (section 6).

## How to read the citations

- `[O.. Lx-y]` cites OpenShell sources at tag **v0.1.5** (commit
  `bdb956f2cd65a635f1294fccf1d138d263bf650f`), listed in [Sources](#sources).
  `[S..]`, `[G..]`, `[C..]` and `[U..]` cite advisories, GitHub API facts,
  CNCF records and upstream Paperclip pull requests.
- `path:line` cites Paperclip at `origin/main` `8d952b8e3`. After a file's
  first full path, later citations in the same section may use its file name
  alone.
- *Inference* marks a conclusion drawn from cited facts, not stated by a
  source. **Unverified** marks a claim no source settles.

## 1. What OpenShell is (verified)

### 1.1 What it does

OpenShell runs each agent in a sandbox and enforces a policy that says what the
agent may touch: files, network destinations, API calls, and where credentials
may go [O1 L19-26]. It has four parts [O2 L18-37]:

- **Gateway:** the control plane. It creates and deletes sandboxes, stores and
  delivers policy, attaches credential providers and authenticates users.
- **Compute driver:** builds the sandbox on one runtime (Docker, Podman,
  Kubernetes or a microVM). A gateway uses one driver at a time [O4 L28-40].
- **Supervisor:** the trusted side. It checks every connection against policy,
  adds credentials, resolves DNS and opens the approved upstream connection.
- **Sandbox (`openshell-sandbox`):** runs inside the boundary with the agent. It
  owns the agent's processes, identifies the program behind each request and
  hands TCP and DNS to the supervisor. It never decides policy.

It fails closed: the agent does not start before the supervisor confirms the
boundary, and the agent is frozen if the supervisor link drops
[O2 L70-79, L181-183].

### 1.2 The isolation it relies on

- **Linux kernel features, probed at start** [O2 L46-51; O3 L171-192]:
  - Landlock LSM ABI 3 or newer (upstream Linux 6.2+) confines file access;
  - seccomp user notification intercepts TCP opens and DNS queries;
  - the workload runs as one non-root identity with no Linux capabilities;
  - a missing feature makes launch fail closed. A kernel version alone does not
    prove support; distribution backports must pass the same probes
    [O3 L183-186].
- **An outer network fence built by the runtime** [O2 L100-105]:

  | Runtime | Supervisor | Channel | Direct egress blocked by |
  |---|---|---|---|
  | Docker, Podman | its own container | Unix socket on a driver volume | workload container has no network |
  | Kubernetes | its own pod | mutual TLS service | `NetworkPolicy` (the CNI must enforce it) |
  | MicroVM (libkrun; KVM or Apple Hypervisor) | host process | vsock | guest has no network device |

- **Docs caveat:** `docs/security/best-practices.mdx` at the same tag still
  describes a network namespace with a veth pair and a proxy on the host-side
  veth address [O11 L53-57]. The architecture page and the support matrix agree with each
  other on the seccomp-mediated design, so this document treats them as
  current. Which one is exact is **unverified** until the spike.

### 1.3 Policy model and language

- **Format:** YAML, `version: 1`, at most 4 MiB. Unknown fields and duplicate
  keys are rejected [O6 L11-13].
- **Five sections** [O5 L27-35; O6 L26-33]:

  | Section | Controls | Enforced by | Changes |
  |---|---|---|---|
  | `filesystem_policy` | read-only and read-write paths | Landlock | at start only |
  | `landlock` | fail or degrade if Landlock cannot apply; **the default `best_effort` degrades** | sandbox runtime | at start only |
  | `process` | `run_as_user` / `run_as_group`; root is rejected [O6 L92] | runtime | at start only |
  | `network_policies` | which binary may reach which host:port, and which requests | supervisor proxy | live |
  | `network_middlewares` | extra inspection or redaction of allowed traffic | supervisor proxy | live |

- **Network rules are deny by default.** Each rule pairs binaries with
  endpoints [O6 L103-116; O11 L40-51]. An endpoint can inspect requests:
  - REST: method, path glob, query;
  - WebSocket: upgrade and client text messages;
  - GraphQL: operation type, name and top-level fields;
  - MCP over HTTP: method and tool name, but **not tool arguments**;
  - JSON-RPC: method only [O6 L156-160, L259-518].
- **Inspection defaults to `audit`, which logs and allows.** Only
  `enforcement: enforce` blocks [O6 L158; O11 L105-114]. Any generator must
  always emit `enforce`.
- **Landlock defaults to `best_effort`.** If none of the listed paths can be
  applied, or Landlock fails to enforce the rules, the sandbox runs *without*
  the filesystem rules and logs a high-severity finding. `hard_requirement`
  makes the sandbox fail to start instead. Both modes skip a single missing
  path [O6 L65-78; O17 L39-40]. Any generator must emit `landlock:
  {compatibility: hard_requirement}`.
- **Never authorized as an outbound destination:** loopback, link-local and
  `169.254.169.254` [O6 L141-146]:
  - a workload can still reach a sandbox-local service on loopback
    [O6 L143-144];
  - the Kubernetes control-plane ports are blocked on exact-host, IP and
    `allowed_ips` endpoints [O6 L146-150];
  - a rule for `host.openshell.internal` can reach gateway-host services
    [O6 L149-150].
- **Binary identity:** a rule matches the calling executable or a parent. Each
  executable is pinned to its first observed SHA-256, and a changed file is
  denied [O6 L526-531; O11 L80-92].
- **Credentials ("providers"):** the agent sees only a placeholder. The proxy
  swaps in the real value only on HTTP requests to endpoints bound to that
  provider (headers, query, path, opt-in bodies, SigV4). It cannot do this for
  `tls: skip` or non-HTTP traffic, cookies or responses [O10 L432-477].
- **TLS:** the proxy terminates TLS with a per-sandbox CA and injects it
  through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO` and similar
  variables [O11 L116-127].
- **Where the active policy comes from:** a gateway-wide global policy, else the
  sandbox's saved policy, else a policy in the image, else a restrictive default
  [O5 L55-64]. The global policy *replaces* sandbox policies; it does not limit
  them [O5 L82-88]. Providers add rules on top ("effective policy")
  [O5 L69-74]. The default allows no network. It grants the working
  directory, `/tmp` and `/dev/null` read-write and a few system paths
  read-only [O17 L26-47].
- **Versioning and apply:** every change is a gateway revision. The sandbox
  validates and loads it; if loading fails, the default `fail_closed` blocks
  traffic [O7 L183-221]. Revisions can be listed, and a rollback resubmits an
  old revision [O7 L78-82, L277-288]. Filesystem and process changes need a new
  sandbox [O7 L189-195].
- **Agent-proposed access (advisor):** when a request is denied, the agent (or
  OpenShell itself, from blocked connections) can propose a narrow network
  rule. A person approves or rejects it with a reason; auto-approve is opt-in
  and only when risk checks find nothing [O8 L11-59, L114-138].
- **Prover:** an SMT-based check that a candidate policy grants nothing beyond a
  boundary policy. It covers filesystem, process, Landlock, connections and
  REST, and reports "cannot check" for GraphQL or MCP rules [O9 L11-34, L57-61].
- **Multi-tenancy:** a workspace isolates sandboxes, providers, policies and
  settings from other workspaces, with admin and user roles [O16 L11-14,
  L28-32].
- **Not covered by the policy:**
  - There is no user-written syscall section. Process control is a fixed
    seccomp profile plus a privilege drop [O6 L26-33; O11 L33].
  - It sees network requests, not an agent CLI's internal tool calls. A Claude
    Code `Bash` or `Edit` call is visible only through the files or connections
    it touches. *(Inference from the five sections above.)*
- **Language churn:** a draft pull request adds Cedar as a second policy
  language [G3].

### 1.4 Platforms

- **Hosts** [O3 L50-57, L192]:
  - Linux (Debian/Ubuntu) on amd64 and arm64: supported;
  - macOS on Apple Silicon through Docker Desktop: supported, with the kernel
    features running in the Docker Desktop VM;
  - Windows WSL 2: experimental.
- **Sandbox binary:** static musl builds for Linux amd64 and arm64
  [O3 L84-90].
- **Kernel:** Landlock ABI 3 (Linux 6.2+) and the seccomp features above
  [O3 L171-192].
- **Runtimes:** Docker Engine 28.0+, Podman 5.x with cgroups v2, Kubernetes
  1.29+ with the Agent Sandbox controller, or KVM for MicroVM
  [O3 L132-143; O4 L188, L279-285].

### 1.5 License, maturity, cadence, governance, advisories, dependencies

- **License:** Apache-2.0 [G1; O1 L91-93].
- **Age and churn:**
  - the repository was created on 2026-02-24 [G1];
  - 100 versioned GitHub releases, from v0.0.6 (2026-03-16) to v0.1.5
    (2026-10-20) [G2];
  - 0.1.0 (2026-09-25) broke deployments, policies, APIs and SDKs. There was
    no in-place upgrade, and every sandbox had to be recreated [O12 L10-27].
    It also introduced "new isolation primitives" [O1 L17]. So the
    CVE-free stretch since April mostly covers 0.0.x code.
- **Cadence and support:**
  - stable releases come weekly, targeting Tuesday;
  - security fixes cover the latest minor line and the one before it (N-1);
  - a Stable interface breaks only in a minor release, while an Experimental
    one may change in a patch release [O3 L29-43].
- **Governance:**
  - a maintainer council decides by lazy consensus and claims vendor
    neutrality [O19 GOVERNANCE.md L12, L56-80, L147-151];
  - there are 13 maintainers: 10 from NVIDIA and 3 from Red Hat
    [O19 MAINTAINERS.md L5-19];
  - the CNCF Sandbox application passed its vote and closed on 2026-10-02.
    Onboarding is open, and the repository is still under the NVIDIA
    organization [C1].
- **Advisories:** NVIDIA bulletin 5872 (2026-08-25) lists six OpenShell CVEs.
  All of them affect 0 to 0.0.33 and were fixed in v0.0.34 (2026-04-21)
  [S1 L17-36, L53-63; S2; G2]:

  | CVE | CVSS | What |
  |---|---|---|
  | CVE-2026-65093 | 9.9 | Linux sandbox escape (CWE-427) [S3] |
  | CVE-2026-65083 | 9.9 | provisioning API with an incomplete denylist (CWE-184) |
  | CVE-2026-65091 | 8.8 | a malicious gateway causes OS command injection |
  | CVE-2026-65092 | 8.5 | path traversal bypass of L7 REST policy |
  | CVE-2026-65086 | 6.8 | command injection in the sandbox exec handler |
  | CVE-2026-65085 | 5.2 | output encoding in the inference proxy |

  Neither NVIDIA's 2026 CVE index nor the repository's GitHub security
  advisories list a later OpenShell CVE (checked 2026-10-21) [S2; S4].
- **Dependencies and integration surface:**
  - written in Rust [G1];
  - the network policy is evaluated by an OPA engine [O11 L31, L38; O6 L53];
  - the prover uses an SMT solver [O9 L11];
  - the gateway stores state in SQLite or an external database [O15 L65;
    O3 L160];
  - the TypeScript SDK needs Node 20.3+ and is published only on GitHub
    Packages, so installing it needs a GitHub token with `read:packages`
    [O14 L16-27];
  - images: the gateway and sandbox runtime come from `ghcr.io/nvidia/openshell/*`,
    and the default workload is `nvcr.io/nvidia/base/ubuntu:24.04` [O3 L152-158];
  - anonymous telemetry is on by default and is turned off with
    `OPENSHELL_TELEMETRY_ENABLED=false` [O1 L83-85].

### 1.6 Footprint

- **Not published.** The v0.1.5 docs give no per-sandbox memory, CPU or start
  latency. The network performance tests measure mean, p50 and p95 latency, but
  they assert no threshold and publish no result [O20 L24-45]. **Unverified;
  the spike in section 6 measures it.**
- **Known structural costs:**
  - Docker and Podman run one supervisor container next to every workload
    container [O2 L100-103];
  - the first sandbox pulls its workload image [O3 L158];
  - `exec` stdin is capped at 4 MiB of pending input per channel [O13 L321];
  - `exec` fails if a background process holds stdout for more than 30 s after
    the command exits [O13 L352-353];
  - `sandbox create` accepts at most 128 environment variables. Each is at
    most 8 KiB with no newline, and the total is at most 256 KiB
    [O13 L421-423]. Per-`exec` limits are **unverified**.

## 2. Where it would sit in Paperclip

### 2.1 Today's run path

```
heartbeat ──acquireForRun──► environment lease ──realizeForRun──► execution target
 (heartbeat.ts:26009)        (environments.ts:1442-1500)       (environment-execution-target.ts:223)
                                                                      │
             adapter.execute(executionTarget) (heartbeat.ts:28475-28485)
                                                                      │
                   runAdapterExecutionTargetProcess (execution-target.ts:870-951)
          ┌──────────────────────────┬────────────────────────────────┴───────────────┐
        local                       ssh                                           sandbox
 runChildProcess → spawn      ssh wrapper from                       runner.execute → plugin worker
 (server-utils.ts:4851,       resolveSpawnTarget                     "environmentExecute"
  4924-4930)                  (server-utils.ts:3804; ssh.ts:1567)   (environment-runtime.ts:2925)
                                                                      e.g. Daytona executeCommand
                                                                      (daytona/src/plugin.ts:1739)
```

Full paths for the diagram:

- `server/src/services/`: `heartbeat.ts`, `environments.ts`,
  `environment-execution-target.ts` and `environment-runtime.ts`;
- `packages/adapter-utils/src/`: `execution-target.ts`, `server-utils.ts` and
  `ssh.ts`;
- `packages/plugins/sandbox-providers/daytona/src/plugin.ts`.
- `acquireForRun` and `realizeForRun` are defined in
  `server/src/services/environment-run-orchestrator.ts:264, 350`.

- **Drivers:** the environment drivers are `local`, `ssh`, `sandbox` and
  `plugin` (`packages/shared/src/constants.ts:601`). A `sandbox` environment
  names a provider, which is a plugin whose manifest declares
  `kind: "sandbox_provider"` (`packages/shared/src/types/plugin.ts:199-203`).
- **Remote adapters:** eight adapters plus the native runner may run off-host
  (`packages/shared/src/environment-support.ts:67-77`). They can use
  `local`, `ssh` or `sandbox` (`environment-support.ts:83-87`).
- **The bridge:** SSH and sandbox targets both count as "remote", and remote
  targets use the callback bridge (`packages/adapter-utils/src/execution-target.ts:554-558`).
- **Local isolation today is thin:**
  - the child inherits the server's environment minus `PAPERCLIP_*`
    (`packages/adapter-utils/src/server-utils.ts:4882-4885`);
  - it runs as the same OS user, with no uid change
    (`server-utils.ts:4924-4930`);
  - the only OS-level confinement is the opt-in, Linux-only `bwrap` wrapper
    (`packages/adapter-utils/src/local-process-sandbox.ts:347-349`). It can
    confine files to the workspace (`filesystemScope: "workspace"`,
    `local-process-sandbox.ts:353-358`), unshare the network and offer an
    allowlisting proxy, but has no uid change and no seccomp
    (`local-process-sandbox.ts:341-345, 378-383, 475-488`).
- **Inside provider sandboxes, enforcement is thin:**
  - Paperclip relies on the provider to isolate the sandbox from the host, and
    "does not enforce these provider rules today"
    (`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md:42-48, 67-68`).
  - For general internet access, "Paperclip does not enforce this policy
    inside the sandbox" (`SANDBOX-REQUIREMENTS.md:70-71`).
  - One provider is a partial exception. The Kubernetes provider writes a
    deny-all plus allowlist egress NetworkPolicy
    (`packages/plugins/sandbox-providers/kubernetes/src/network-policy.ts:47-139`).
    Filtering by host name needs `egressMode: "cilium"`
    (`kubernetes/src/manifest.ts:74-77`). In standard mode a host-name
    allowlist falls back to all public IPv4 on ports 80 and 443
    (`kubernetes/src/plugin.ts:227-230`).
  - So Paperclip enforces no filesystem, L7 (method and path) or credential
    rule inside a provider sandbox, and host-level egress only on Kubernetes.

### 2.2 The seam: a sandbox-provider plugin

A new provider at `packages/plugins/sandbox-providers/openshell/` would sit next
to `cloudflare`, `createos`, `daytona`, `e2b`, `exe-dev`, `kubernetes`, `modal`
and `novita`. It plugs in like this:

- **It implements the plugin SDK hooks** (`packages/plugins/sdk/src/define-plugin.ts:366-461`):
  - `onEnvironmentAcquireLease` creates an OpenShell sandbox with the compiled
    policy;
  - `onEnvironmentExecute` runs `argv` in it, with cwd, env and stdin. It
    returns stdout and stderr when the command ends
    (`packages/plugins/sdk/src/protocol.ts:735-744, 759-766`). Live output
    comes from separate log-tail execs
    (`packages/adapter-utils/src/execution-target.ts:885-890`);
  - `onEnvironmentSyncIn` / `onEnvironmentSyncOut` move the workspace;
  - `onEnvironmentReleaseLease` / `onEnvironmentDestroyLease` delete the
    sandbox (`define-plugin.ts:386, 398`).
- **It satisfies the runner contract:** anything that implements
  `CommandManagedRuntimeRunner.execute` with optional `syncIn`/`syncOut`
  (`packages/adapter-utils/src/command-managed-runtime.ts:60-133`) is a complete
  backend for every remote adapter.
- **The bridge needs no egress rule.** The host pulls bridge requests through
  `runner.execute` and forwards them with the real token
  (`execution-target.ts:4709-4713, 4749-4750`). So the compiled policy does not
  need an egress rule to the Paperclip API. The agent reaches the in-sandbox
  bridge on loopback (`packages/adapter-utils/src/sandbox-callback-bridge.ts:2583`),
  and OpenShell allows sandbox-local loopback services [O6 L143-144].
  *(Inference from the transport design; spike row 11 checks it.)*
- **The plugin process lives in the app container.** It is forked from the
  Paperclip server (`server/src/services/plugin-worker-manager.ts:2987`). It
  would need a network path to an OpenShell gateway, plus a client: the
  `openshell` CLI binary, the GitHub-Packages-only SDK, or a client generated
  from OpenShell's protobufs.
- **No change to the core provider interface, but shipping touches core
  files:**
  - an entry in the bundled-plugin catalog, as Daytona and Kubernetes have
    (`server/src/services/bundled-plugins.ts:63-68, 98-115`);
  - the image's built provider list, today `CLOUD_BUNDLED_PLUGINS="daytona"`
    (`Dockerfile:316-321`);
  - an entry in the provider credential passthrough table, if the gateway
    key comes from the server environment
    (`server/src/services/plugin-loader.ts:140-149`);
  - the OpenShell client in the app image.

**Prior art upstream.** Two open, unmerged pull requests exist upstream [U1]:

- **`paperclipai/paperclip#9220`** adds exactly this plugin at
  `packages/plugins/sandbox-providers/openshell/`: 15 files, +3,627 lines, a
  gRPC client and vendored OpenShell protos.
  - It opened on 2026-07-08, before OpenShell 0.1.0 changed protocol field
    names and time types [O12 L25, L77].
  - It has bot reviews only.
  - A 2026-10-17 comment reports that its branch is out of date.
  - *Inference:* its protos need regenerating for 0.1.x.
- **`#8953`** adds an `openshell_direct` adapter instead. `#9220` calls the
  plugin route "architecturally preferred" [U1].

Slice 1 below should start from `#9220`, not from scratch.

### 2.3 Path by path

| Paperclip path | What it does today (file:line) | OpenShell would |
|---|---|---|
| Local adapters | `runChildProcess` → `resolveSpawnTarget` → `spawn` (`server-utils.ts:3786-3871, 4851, 4924-4930`); optional Linux-only `bwrap` for claude-local and codex-local in CLI mode only, which can confine files to the workspace (`local-process-sandbox.ts:341, 347-349, 353-358`; `packages/adapters/claude-local/src/server/acp.ts:105-108`) | **Not apply in production.** It cannot run in the app container (section 4.1). A host-local wrapper at `resolveSpawnTarget` is possible later on a Linux host and could supersede `bwrap`, but it is not proposed. |
| SSH workers | `buildSshSpawnTarget` runs `exec env K=V cmd` remotely (`packages/adapter-utils/src/ssh.ts:1567-1671`); the workspace moves by git bundle plus tar (`ssh.ts:2017-2073, 2075-2172`); the command runs as the SSH account through a plain `exec env` line (`ssh.ts:1605-1607`), and the `bwrap` wrapper applies only to local targets (`execution-target.ts:939`) | **Replace, for opted-in runs.** Run an OpenShell gateway on the worker host and reach it through the provider plugin. Wrapping the SSH `exec` line would add a second lifecycle over SSH, so SSH stays as it is for other runs. |
| Daytona runner | Daytona provider plugin; image from `docker/daytona-runner/Dockerfile:48` running as user `daytona` (`docker/daytona-runner/Dockerfile:133`); commands through `sandbox.process.executeCommand` (`packages/plugins/sandbox-providers/daytona/src/plugin.ts:1739`) | **Not apply.** OpenShell would be a peer provider, not a layer inside Daytona (section 4.3). |
| Native runner | `paperclip-runnerd` started locally (`packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts:3584-3589`) or in a sandbox through `runner.execute` (`server/src/services/native-runtime/native-session-executor.ts:10446-10465`); runner API restricted by `server/src/services/native-runtime/runner-api-policy.ts:1-66` | **Wrap through the provider.** The remote launcher runs unchanged. The runner needs either an ingress endpoint (`runnerWebSocketIngress`) or one egress rule to the runner URL (`packages/adapter-utils/src/runner-connectivity.ts:20-31`). OpenShell's service exposure [O13 L495] is **unverified** for this use. The runner API policy stays. |
| Execution environments and leases | `environments.driver` plus the provider in config (`packages/db/src/schema/environments.ts:4-30`); leases with `ephemeral` / `reuse_by_environment` / `retain_on_failure` (`packages/shared/src/constants.ts:607-618`; `packages/db/src/schema/environment_leases.ts:8-53`) | **Extend, with no change to the core provider interface** (shipping needs the registrations in section 2.2). A new provider key under driver `sandbox`. An ephemeral lease is one sandbox per run; a reused lease keeps the sandbox. |
| Sandbox-callback-bridge allowlist | route and header allowlist (`packages/adapter-utils/src/sandbox-callback-bridge.ts:160-315`); the host swaps the bridge token for the real agent JWT (`execution-target.ts:4709-4713, 4749`) | **Keep.** OpenShell does not see Paperclip routes or actors. The two are complementary: OpenShell fences the network, the bridge fences the Paperclip API. |
| Low-trust runtime containment | requires `selectedEnvironmentDriver === "sandbox"` (`server/src/services/low-trust-runtime-containment.ts:84-88`); runner network off unless the preset is standard (`server/src/services/heartbeat.ts:26331-26335`); API-side denials in `server/src/services/authorization.ts:985-1117` | **Wrap and strengthen.** An OpenShell provider satisfies the sandbox requirement and adds the egress and filesystem enforcement that is missing today. API-side containment stays. |
| `tool_policies` engine | per-company rules: allow, block, require approval, trust, rate limit (`packages/db/src/schema/tool_access.ts:573-596`; `packages/shared/src/constants.ts:1190-1200`); evaluated for MCP calls through Paperclip's tool gateway (`server/src/services/tool-access-policy.ts:1343-1483`) | **Keep.** The gateway sees full tool arguments, while OpenShell sees only tool names on MCP over HTTP [O6 L335-350]. OpenShell can add one thing: deny direct egress to MCP servers, so every tool call must pass the gateway. |
| Protected agent-config guard | about 70 adapterConfig keys, including `sandbox`, `filesystemScope`, `networkScope` and `networkAllowlist` (`server/src/services/agent-self-config-authz.ts:30-102, 84-91`); guard at `server/src/services/agent-protected-change-guard.ts:38-77` | **Keep and extend.** Any new key that selects or loosens a sandbox policy must join the protected list, or an agent could edit its own sandbox. |
| GitHub operation classification | the shared classifier (`packages/shared/src/github-write-identity.ts:1485-1487`), with server checks for branch protection and write identity (`server/src/services/github-write-identity.ts:317-474`), enforced by `git`/`gh` launcher wrappers (`packages/adapter-utils/src/github-launcher.ts:1241-1245, 1398-1416`) | **Keep.** OpenShell sees HTTPS requests to GitHub, not which branch a `git push` targets. *(Inference.)* It can add a coarse rule: only the image's real `git` and `gh` binaries may reach github.com. |

## 3. Link to Policies

The Policies work is building `company_policies`: written guidance for a
company or one project, which enforces nothing by itself. Slice 2 adds
`policy://` mentions and a prompt index. (Plan:
`doc/plans/2026-10-21-policies.md` on branch `feat/company-policies`, not yet
on `origin/main`.)

### 3.1 Which guardrails can move from guidance to enforcement

| Guardrail | Today | With OpenShell |
|---|---|---|
| "Only talk to approved hosts", "no data exfiltration" | guidance; host allowlists exist only in `bwrap` (local Linux claude/codex runs) and the Kubernetes provider (exact host names only in `cilium` mode) | **Enforced:** egress allowlist per binary, deny by default |
| "Only use approved package registries" | guidance, with the same two exceptions | **Enforced:** egress allowlist |
| "Read-only access to service X" | guidance | **Enforced:** REST `access: read-only` with `enforce` |
| "Never call production or metadata endpoints" | guidance | **Enforced:** deny rules; metadata is never an allowed destination [O6 L141-146] |
| "Stay inside the workspace; don't read home or secret files" | guidance; `bwrap` `filesystemScope: "workspace"` for local Linux claude/codex runs only (`local-process-sandbox.ts:353-358`) | **Enforced in every OpenShell sandbox:** `filesystem_policy` (Landlock), with `hard_requirement` |
| "Secret X is used only with service Y" | env injection, so the agent sees the value (`packages/adapters/claude-local/src/server/execute.ts:309-317`) | **Enforced:** provider binding with placeholders [O10 L432-477] |
| Protected branches, pull request for every change | GitHub classifier and launcher | stays in Paperclip and GitHub |
| Which MCP tools, with which arguments | `tool_policies` | stays in Paperclip |
| Spend | budget hard stop (`server/src/services/budgets.ts:649-716`) | stays in Paperclip |
| Code style, review habits, tone, escalation, docs rules | guidance | stays guidance; nothing to observe at the OS layer |

### 3.2 How a policy would compile into an enforced OpenShell policy

A policy keeps its markdown body as guidance. A **separate, typed, board-only
"controls" list** carries the enforceable part. It is never parsed out of the
markdown, because that text is prompt-shaped and anyone who can edit it could
smuggle in rules.

**Control kinds (a closed set):**

| Control | Compiles to |
|---|---|
| `egress.allow {host, port, access or method+path}` | a `network_policies` endpoint with `protocol: rest` and `enforcement: enforce`; `binaries` come from the image manifest's resolved CLI paths (see the binary note below) |
| `egress.deny {host, method, path}` | `deny_rules` on that endpoint; a subtree deny emits both `<path>` and `<path>/**` |
| `fs.read_only` / `fs.read_write` (relative to the workspace) | `filesystem_policy` paths, with `include_workdir: true`, always with `landlock: {compatibility: hard_requirement}` |
| `credential.bind {secret, host}` | an OpenShell provider attached to the sandbox, bound to that endpoint |
| `runtime.require: sandboxed` | placement: the run must use a sandbox provider that enforces policy; not an OpenShell field |
| `mode: audit \| enforce` | `enforcement` on each endpoint, for a staged rollout |

**Merge order: company → project → routine or step → agent. The strictest rule
wins:**

- **Allows narrow.** A scope that sets an allow list replaces "anything the
  scope above allows" with the overlap (intersection). A scope that sets nothing
  inherits.
- **Denies add up** (union).
- **Files:** a path is writable only if every scope that sets filesystem rules
  allows writing it, and readable only if every such scope allows at least
  reading it.
- **`mode`:** `enforce` wins over `audit`. **`runtime.require`:** required if
  any scope requires it.
- **Paperclip baseline:** Paperclip adds the endpoints the run itself needs,
  such as the adapter's model API. A save that would block that baseline is
  rejected with a clear error, not discovered mid-run.
- **Formal check:** the compiled run policy is the candidate. The boundary is
  the company's controls plus the Paperclip baseline plus the rules the
  attached OpenShell providers contribute [O5 L69-74]. `openshell-prover` can
  check that the candidate stays inside that boundary [O9 L19-23, L49-61]. A
  widened project rule then fails before it ships.
- **Who can attach controls:** only board-authored scopes (company, project,
  routine, agent config). A `policy://` mention in issue text pulls in guidance
  only. Merging can only narrow access, so a mention could not widen it, but
  low-trust or external text could still use one to block a run.

**Example.** The company allows the model API, GitHub read-write and npm
read-only. The project drops npm and denies every call to repository webhooks
on GitHub. The compiled policy, for an image like the Daytona runner image:

```yaml
version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /etc]
  read_write: [/tmp]
landlock:
  compatibility: hard_requirement
network_policies:
  model_api:
    endpoints:
      - {host: api.anthropic.com, port: 443, protocol: rest, enforcement: enforce, access: read-write}
    binaries: [{path: <resolved claude executable>}]
  github:
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-write
        deny_rules:
          - {method: "*", path: "/repos/*/*/hooks"}
          - {method: "*", path: "/repos/*/*/hooks/**"}
    binaries: [{path: /usr/local/bin/gh}]
```

- **Schema fit.** Per [O6 L217-218], `deny_rules` needs `protocol` and an
  `access` or `rules`, and the example has both. The deny form follows the
  schema's own example [O6 L279-281].
- **Two deny paths.** `*` does not cross `/`, and `/repos/**` does not match
  `/repos` itself [O6 L569-583]. So one rule covers the hooks list and the
  other covers each hook and its sub-paths.
- **Binaries must be real paths.** A rule must list the executable's real path,
  not a symlink, and a script matches its interpreter [O6 L526-531].
  - In the Daytona runner image, `gh` is the binary `/usr/local/bin/gh`
    (`docker/daytona-runner/Dockerfile:96`).
  - `claude`, `codex` and `opencode` there are `sh` wrappers that `exec` a
    Node package bin (`docker/daytona-runner/Dockerfile:105-107`). The
    connection then comes from the Node interpreter.
  - *Inference:* Node CLIs that share one interpreter cannot be told apart by
    binary, which weakens per-binary scoping. An OpenShell image should give
    each CLI its own executable where it can, and the compiler must emit
    resolved paths from the image manifest.
- Only `gh` may reach `api.github.com` here. A `git` push to `github.com` would
  need its own rule.

### 3.3 Schema hook for Policies slice 1: none

- **The recommendation: reserve nothing now.** Enforcement, if it comes, goes in
  a child table such as `company_policy_controls`:
  - `policy_id` references `company_policies.id`, with cascade;
  - plus `company_id`, `kind`, `spec` (jsonb with a zod schema), `mode` and
    timestamps.

  That is an additive migration and touches no slice 1 row. A reserved column
  now would be dead schema, and the parity rule would carry it through UI, REST
  and CLI.
- **What would be expensive to change later.** Slice 1 should keep:
  1. the key immutable and unique per company, with archive keeping it
     reserved;
  2. writes board-only and reads only for agents. Controls must never become
     agent-writable;
  3. `company_policies.id` as the stable identity, with cascade on hard delete;
  4. no free-form `metadata`/`config` jsonb and no "enforced" status. `status`
     means guidance visibility only (draft/active/archived), and enforcement
     mode lives on the controls.
- **Sent to the owner of the Policies work on 2026-10-21, before its slice 1
  merged.**
- **The later run record:** each run would record the compiled policy hash and
  the control revisions it used, as run-log events
  (`packages/db/src/schema/heartbeat_run_events.ts:18`). That data stays in the
  instance database, so it needs no extra review under rule 7 of `AGENTS.md`.

### 3.4 Approvals and board gates

**A sandbox denial becomes a board gate.** The existing pattern to reuse is
the tool gateway. When a policy returns `require_approval`, Paperclip:

- records a request, and for destructive tools an `approvals` row of type
  `request_board_approval` (`server/src/services/tool-gateway.ts:2454-2460`);
- creates an issue interaction with kind `request_confirmation`,
  resolver `human_only` and continuation `wake_assignee`
  (`tool-gateway.ts:2491-2500`).

The Inbox lists both approvals and decisions
(`server/src/services/attention.ts:68-80`).

**A plugin cannot create a Decision today.**

- A `decisions` row needs a non-null origin agent, issue and run
  (`packages/db/src/schema/decisions.ts:43-45`), and the plugin SDK has no
  call that creates one (no match in `packages/plugins/sdk/src/`).
- What the SDK does offer is issue interactions, such as
  `requestConfirmation` and `askUserQuestions`
  (`packages/plugins/sdk/src/types.ts:1455, 1600, 1606`).
- So slice 4 either maps a denial onto a `request_confirmation` interaction,
  or adds a host capability that lets a provider plugin open a Decision for the
  run it serves. Either way the board decides; the plugin never approves on its
  own.

The flow:

1. The sandbox denies a request. The agent, or OpenShell itself, files a
   narrow proposal [O8 L29-59].
2. The provider plugin reads the pending proposal and raises a board gate on
   the run's issue (an interaction or a Decision, per slice 4). Its options are:
   allow for this run; allow and add to the project policy; reject with a
   reason. The OpenShell API call to list proposals is **unverified**; the CLI
   is `openshell rule get --status pending` [O8 L116-122].
3. **A proposal outside the company boundary never reaches the board as a
   one-click approval.** It is rejected with "exceeds company policy", because
   widening needs a company policy edit.
4. On a board decision, the plugin approves or rejects in OpenShell
   [O8 L124-138]. "Add to the project policy" writes a control and logs
   activity. An expiry, if the gate has one, rejects the proposal.
5. OpenShell auto-approve stays off (its default) [O8 L21-25], so the board is
   the only approver.

## 4. Production fit

### 4.1 The production instance

The app container is locked down (`deploy/compose.yaml:8-9, 31-41`):

- it runs as uid 1000 with a read-only root;
- `cap_drop: [ALL]` and `no-new-privileges`;
- 2 GB of memory and 256 pids (`compose.yaml:38-39, 41`);
- no container runtime socket is mounted (`compose.yaml:31-33`).

- **The gateway cannot live in the app container.** Every built-in OpenShell
  driver needs a container runtime, a cluster or a hypervisor [O4 L18-24;
  O3 L136-143], and the app container has none of them.
- **Where a gateway could run instead:**
  - a Docker gateway on a separate host. It needs the Docker socket [O15
    L17-23]. *Inference:* access to that socket is root-equivalent on that
    host;
  - a rootless Podman gateway [O4 L21, L188; O3 L128, L139], which avoids a
    root daemon;
  - a Kubernetes gateway installed with the Helm chart, with the Agent Sandbox
    controller [O4 L279; O3 L129, L140];
  - a MicroVM gateway on a KVM host [O4 L215; O3 L143].
- *Inference:* keep OpenShell off the production VM, on worker hosts or a
  cluster.
- **The kernel of the production VM was not checked** (out of scope). Only the
  plugin client would run there.
- **Memory:** the plugin worker shares the 2 GB cap (`NODE_OPTIONS
  --max-old-space-size=1536`, `deploy/compose.yaml:28`). Its per-run cost is
  **unverified**.

### 4.2 SSH worker hosts

Each opted-in worker host would need:

- Linux 6.2+ with Landlock enabled, passing OpenShell's probes [O3 L171-192];
- one runtime: Docker Engine 28+ or rootless Podman 5.x [O3 L138-139];
- for Docker, a gateway user in the docker group [O15 L21-23]. *Inference:*
  that is root-equivalent on the host, and rootless Podman, which runs
  sandboxes as rootless containers [O4 L188], avoids it.

**Workspace sync should be native.**

- For sandbox providers, Paperclip turns off the single-stream stdin path
  (`supportsSingleStreamStdinProgress: false`,
  `server/src/services/environment-execution-target.ts:416-420`).
- So its generic sync writes files in chunks of 4 MiB of base64, one `exec`
  with stdin per chunk
  (`packages/adapter-utils/src/command-managed-runtime.ts:159, 296, 304-306, 330-334`).
- That chunk is exactly OpenShell's 4 MiB pending-stdin cap per exec channel
  [O13 L321]. Whether a chunk at the cap passes is **unverified**; spike row 10
  checks it.
- `openshell sandbox upload` streams with bounded buffering, so the 4 MiB
  budget does not limit its total size [O13 L903, L911-912]. The plugin
  should implement `syncIn`/`syncOut` with `upload`/`download`, which also
  saves one `exec` per chunk. Note that `upload` fails when git filtering
  fails [O12 L85].

### 4.3 Daytona

- **Nesting OpenShell inside Daytona is not viable on current evidence:**
  - the runner image runs as user `daytona` (`docker/daytona-runner/Dockerfile:133`);
  - OpenShell needs Docker, Podman, Kubernetes or KVM to build its sandbox
    [O4 L18-24];
  - OpenShell has no Daytona driver (nothing in the v0.1.5 tree; issue search
    finds none).
- OpenShell does accept external compute drivers over a Unix socket
  [O4 L64-76]. A Daytona driver could be written, but it would be new work
  outside Paperclip.
- Nesting is **unverified rather than disproven**.
- **The practical answer:** Daytona stays a separate provider, and OpenShell is
  added beside it.

### 4.4 Per-run overhead (unmeasured)

- **Per run:**
  - two containers (supervisor and workload) [O2 L100-103];
  - kernel qualification probes [O3 L179-182];
  - a policy load;
  - a workspace upload;
  - one TLS termination per connection [O11 L118-124].
- **Per host:** a cold host pulls the workload image [O3 L158].
- **No published numbers** [O20 L24-45]. The spike measures them.

### 4.5 New failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| The gateway on a host is down | no new sandboxes on that host | one provider environment per host; the run fails clearly |
| The supervisor link drops | the agent is frozen [O2 L181-183] | the existing run watchdog and recovery |
| A policy revision fails to load | `fail_closed` blocks all traffic [O7 L214-221] | validate and prove before the save |
| The agent CLI updates itself | the binary hash changes and requests are denied [O6 L526-531; O11 L92] | bake pinned CLIs into the image, as the Daytona image already pins them (`docker/daytona-runner/Dockerfile:142-147`) |
| A CLI ignores the injected CA | every TLS call fails | Node honors `NODE_EXTRA_CA_CERTS` [O11 L124]; Rust CLIs such as Codex are **unverified** |
| L7 left in `audit` | silent allow [O6 L158] | the compiler always emits `enforce` except in audit mode |
| Landlock left at `best_effort` | the sandbox runs without filesystem rules when they cannot apply [O6 L65-78] | the compiler always emits `compatibility: hard_requirement` |
| Kernel features are missing | launch fails closed [O3 L183-186] | probe in environment validation |
| An OpenShell upgrade breaks things | 0.1.0 needed every sandbox recreated [O12 L25-27] | pin the version; prefer ephemeral leases |
| Subscription-token agents | claude-local can use `CLAUDE_CODE_OAUTH_TOKEN` (`packages/adapters/claude-local/src/server/acp.ts:817-850`), but OpenShell's Claude Code profile covers only the API key header [O18 claude-code.yaml L17-36] | a custom profile (**unverified**), or plain env as today |

### 4.6 Token efficiency and latency

- **Tokens:** OpenShell adds no prompt of its own, with two exceptions:
  - the advisor, if enabled, adds a skill file and an `/AGENTS.md` when the
    image has none [O8 L61-74];
  - each denial costs the agent turns, since it reads a 403 and retries.

  Keep the advisor's file out of the image's agent instructions, and trial new
  policies in `audit` mode first. Session resume should work as it does for
  other sandbox providers: the run assets live under the workspace's
  `.paperclip-runtime/<adapterKey>` directory
  (`packages/adapter-utils/src/sandbox-managed-runtime.ts:1128`), and the
  bridge files under its `paperclip-bridge` subdirectory
  (`packages/adapter-utils/src/execution-target.ts:4641-4642`). That is
  **unverified** for OpenShell.
- **Latency:** sandbox creation plus sync per run, and image pulls on cold
  hosts. Reused leases (`reuse_by_environment`) amortize creation. The amounts
  are **unmeasured**.

## 5. Options and recommendation

| | A. Default runtime for every run | B. Opt-in sandbox provider that policies can require | C. Don't adopt; borrow ideas |
|---|---|---|---|
| Cost | High: every path moves, including local and production. Every agent image must be rebuilt, and macOS development needs Docker Desktop. | Medium: one plugin, one image, a policy compiler and an approval bridge | Low to medium |
| Risk | High: a young project with breaking minors and recent critical CVEs becomes a single dependency for all work | Contained to opted-in runs; fails closed | Low; enforcement stays as weak as today inside sandboxes, and the controls that compile are host-level only (see below) |
| Migration | big bang, or a long dual-run | per environment: create an `openshell` environment and point agents or projects at it | none |
| Rollback | hard: you have to re-home every run | disable the plugin or archive the environment. Runs that a policy requires to be sandboxed stay blocked until another provider is chosen, never silently unsandboxed | n/a |
| Code removed | maybe `bwrap` (`local-process-sandbox.ts`) and some providers, later | none at first | none |
| Code added | everything in B, plus local and SSH rewiring | `sandbox-providers/openshell` and its bundling entries (section 2.2), the controls table, the compiler, placement, and the board-gate bridge (core changes in slices 2–5) | controls compiled into existing enforcement: the Kubernetes provider's egress NetworkPolicy (`packages/plugins/sandbox-providers/kubernetes/src/network-policy.ts:47-139`) and the `bwrap` allowlist (`local-process-sandbox.ts:475-488`) |

**Recommendation: B, gated by a spike.**

- **Why B over A:**
  - **The evidence argues against default-on now:**
    - a 0.1.x line with breaking minors [O12 L10-27];
    - one critical sandbox escape (CVE-2026-65093) and one critical
      provisioning-API flaw, fixed six months ago [S1; S3; G2], before the
      0.1.0 isolation changes [O1 L17];
    - no published footprint;
    - a container runtime, cluster or KVM needed on every host that runs
      sandboxes.
  - **B is cheap and reversible:** the provider seam already exists, so slice 1
    needs no change to the core provider interface, only the bundling entries
    in section 2.2.
- **Why B over C:**
  - inside provider sandboxes, Paperclip enforces no filesystem, L7 or
    credential rule, and host-level egress only on Kubernetes (section 2.1);
  - low-trust work already depends on a sandbox driver
    (`low-trust-runtime-containment.ts:84-88`);
  - OpenShell gives kernel-level filesystem rules, per-binary L7 egress,
    credential placeholders and a proposal flow that Paperclip would otherwise
    have to build.
- **If the spike fails, fall back to C.** Only part of the controls model in
  section 3 survives:
  - `egress.allow` compiles to host-level allowlists: the Kubernetes provider's
    NetworkPolicy (exact host names only with Cilium) and the `bwrap` proxy
    allowlist (local Linux claude/codex runs);
  - `fs.*` compiles to `bwrap` `filesystemScope: "workspace"` on local Linux
    runs only;
  - method and path rules, `egress.deny` on paths, `credential.bind` and
    `mode: audit` have no target and stay guidance.

**Sliced build plan for B.** Each slice is its own PR from current
`origin/main` and passes the gate. User-facing slices ship UI, REST/OpenAPI,
CLI and the paperclip skill together (rule 8).

0. **Spike (no Paperclip code).** Section 6. A go or no-go for the people who
   decide.
1. **The OpenShell sandbox-provider plugin.**
   - Start from upstream `#9220` [U1], rebased and moved to OpenShell 0.1.x.
   - Hooks: acquire, execute, native sync, release, destroy, against one
     gateway.
   - Policy: a static deny-all-plus-baseline policy from the environment
     config, with `enforce` and `hard_requirement`.
   - Shipping: the bundled-plugin, image and credential entries from
     section 2.2.
   - Image: pinned CLIs at resolved paths, built the way
     `docker/daytona-runner` is.
   - Tests: contract tests against a fake gateway.
   - Parity: it is configured through the existing environment UI, REST and
     CLI, so it needs no new surface.
   - Value: low-trust runs can select it immediately.
2. **Policy controls, audit only.**
   - The additive `company_policy_controls` table, with board-only CRUD and
     activity logging.
   - The pure compiler, with unit tests and a prover check.
   - A "would deny" preview, and a CLI `paperclipai policy controls …`.
3. **Enforcement.**
   - Merge controls company → project → routine → agent per run.
   - `runtime.require` drives placement, and a run fails closed when no
     enforcing provider is available.
   - Record the compiled hash and the control revisions in the run log.
4. **Denials become board gates:** the flow in section 3.4, including
   approve-once, persist-to-policy, reject-with-reason and expiry. This slice
   either reuses the `request_confirmation` interaction or adds a host
   capability for a plugin to open a Decision.
5. **Credentials through providers:** model keys as placeholders. GitHub stays
   on the existing broker.

## 6. Spike plan (needs a Linux host; not run)

The evaluation had no suitable host: the development machine was short of
disk, and the task ruled out production and all infrastructure. So no spike
was run. **The spike needs a host from the operator:**

- a throwaway Linux VM with Linux 6.2+ and Landlock enabled;
- Docker Engine 28+ (or rootless Podman 5.x);
- 20 GB or more of free disk;
- egress to the model APIs;
- not production and not a worker host.

| # | Check | Pass |
|---|---|---|
| 1 | Install v0.1.5 and create a sandbox with the default image | the sandbox admits; probes pass |
| 2 | Cold and warm create-to-first-exec, 20 runs | p95 recorded; proposed bar: warm ≤ 5 s, cold with a cached image ≤ 20 s |
| 3 | Idle memory of supervisor plus workload | recorded; proposed bar ≤ 150 MiB per run |
| 4 | The same prompt through Claude and Codex CLIs, sandboxed and plain | tokens within ±5 %; wall-time overhead ≤ 15 s |
| 5 | Credential placeholder | `printenv` shows a placeholder; the bound host works; the same placeholder to another host is denied |
| 6 | Egress | unlisted host denied with `policy_denied`; `GET` allowed; `DELETE` denied under `enforce`, allowed under `audit` |
| 7a | Gateway killed mid-run | the running sandbox's behavior is recorded; no new sandbox starts; the run fails clearly |
| 7b | Supervisor link dropped mid-run | the agent freezes [O2 L181-183], then resumes or fails clearly |
| 8 | A broken policy revision | rejected; the previous policy stays active |
| 9 | Replace the CLI binary mid-run | requests denied (documents the pinning risk) |
| 10 | A 200 MB repo through `upload` and `download`; and one exec with exactly 4 MiB of base64 stdin, as Paperclip's generic sync sends | byte-identical round trip; the 4 MiB chunk passes or the generic sync is ruled out |
| 11 | Paperclip's callback bridge over `exec`, with the bridge on loopback | works with no egress rule to Paperclip |
| 12 | Prover: compiled candidate against company boundary plus baseline | passes; a widened candidate fails |
| 13 | Codex and other Rust or Go CLIs with the injected CA | TLS works |
| 14 | `hard_requirement` with an unusable filesystem rule set | the sandbox refuses to start |
| 15 | A Node CLI started through an `sh` wrapper | the policy matches the resolved interpreter; record which binary OpenShell reports |

The bars in rows 2–4 are proposals for the decision owner to confirm.

## 7. Open questions and unverified claims

- Which OpenShell network design is current (section 1.2 docs caveat).
- Per-sandbox footprint and latency (section 1.6).
- Whether the TLS CA injection works for every CLI Paperclip ships.
- Subscription OAuth tokens as OpenShell provider credentials.
- The OpenShell API call for listing and deciding proposals from a plugin.
- Whether OpenShell's service exposure can serve the native runner's ingress.
- Whether a 4 MiB base64 stdin chunk passes OpenShell's pending-stdin cap
  (section 4.2), and the per-`exec` environment limits (section 1.6).
- What a running sandbox does when its gateway dies (spike row 7a).
- The kernel and container runtime versions of the worker hosts.

**What the user needs to decide:**

1. A go or no-go on Option B.
2. A Linux spike host.
3. Whether subscription-token agents must also run sandboxed.

## Sources

**OpenShell, tag v0.1.5** (`https://github.com/NVIDIA/OpenShell/blob/v0.1.5/<path>`):

| ID | Path |
|---|---|
| O1 | `README.md` |
| O2 | `docs/about/architecture.mdx` |
| O3 | `docs/about/support-matrix.mdx` |
| O4 | `docs/how-it-works/sandboxes/runtimes.mdx` |
| O5 | `docs/how-it-works/policies/overview.mdx` |
| O6 | `docs/how-it-works/policies/schema.mdx` |
| O7 | `docs/how-it-works/policies/manage-policies.mdx` |
| O8 | `docs/how-it-works/policies/advisor.mdx` |
| O9 | `docs/how-it-works/policies/prover.mdx` |
| O10 | `docs/how-it-works/providers/overview.mdx` |
| O11 | `docs/security/best-practices.mdx` |
| O12 | `docs/upgrade/0-1-0.mdx` |
| O13 | `docs/how-it-works/sandboxes/overview.mdx` |
| O14 | `docs/sdk/typescript.mdx` |
| O15 | `docs/how-it-works/gateways/container-deployment.mdx` |
| O16 | `docs/how-it-works/workspaces.mdx` |
| O17 | `docs/how-it-works/policies/default-policy.mdx` |
| O18 | `providers/claude-code.yaml` |
| O19 | `GOVERNANCE.md`, `MAINTAINERS.md` |
| O20 | `e2e/rust/tests/internet_network_perf.rs` |

**Advisories, GitHub and CNCF:**

| ID | Source |
|---|---|
| S1 | NVIDIA bulletin 5872, revision 1.0.0, 2026-08-25: `https://github.com/NVIDIA/product-security/blob/main/2026/5872/5872.md` (mirror of `https://nvidia.custhelp.com/app/answers/detail/a_id/5872`) |
| S2 | NVIDIA 2026 CVE index: `https://github.com/NVIDIA/product-security/blob/main/2026/CVE_index.csv` (fetched 2026-10-21) |
| S3 | CVE record: `https://cveawg.mitre.org/api/cve/CVE-2026-65093` (CNA nvidia, published 2026-08-25, affected 0 to 0.0.33) |
| S4 | `GET /repos/NVIDIA/OpenShell/security-advisories` returned `[]`; the GitHub Advisory Database has no entry for the PyPI package `openshell` (both 2026-10-21) |
| G1 | `GET /repos/NVIDIA/OpenShell` (2026-10-21): Apache-2.0, Rust, created 2026-02-24 |
| G2 | `GET /repos/NVIDIA/OpenShell/releases`: 100 versioned releases; v0.0.6 2026-03-16, v0.0.34 2026-04-21, v0.1.0 2026-09-25, v0.1.5 2026-10-20 |
| G3 | NVIDIA/OpenShell PR #4565, "support Cedar as an alternate sandbox policy language", an open draft on 2026-10-21 |
| C1 | `cncf/sandbox#522` (closed 2026-10-02, labels `gitvote/passed`); `cncf/sandbox#535` onboarding (open) |
| U1 | `https://github.com/paperclipai/paperclip/pull/9220` (open, created 2026-07-08, 15 files) and `https://github.com/paperclipai/paperclip/pull/8953` (open, created 2026-07-03), both read 2026-10-21 |

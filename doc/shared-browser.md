# Shared browser profiles

A company keeps a browser login (a *profile*) that a board user signs in to once and
that the agents the board allows can reuse between runs. Design, options and the
full threat model: [`plans/2026-10-09-shared-browser.md`](plans/2026-10-09-shared-browser.md).
This page documents what ships in the first slice.

## What ships

| Piece | Where |
| --- | --- |
| Contracts | `packages/shared/src/browser-profiles.ts` |
| Tables (`browser_profiles`, `browser_profile_agents`, `company_browser_settings`) | `packages/db/src/schema/browser_profiles.ts`, migration `0296` |
| Sealing (AES-256-GCM, company/profile/generation bound) | `server/src/services/browser-profile-seal.ts` |
| Navigation and snapshot policy | `server/src/services/browser-profile-policy.ts` |
| Browser engine (Playwright, optional) | `server/src/services/browser-executor.ts` |
| Service and routes | `server/src/services/browser-profiles.ts`, `server/src/routes/browser-profiles.ts` |
| Board UI | Company settings → **Shared browser** |

## Turning it on

1. The server needs a Chromium. The standard image has none. Set
   `PAPERCLIP_BROWSER_EXECUTABLE_PATH` to a Chromium executable. Without it the page
   reports "No browser is configured" and nothing launches.
2. A board user opens Company settings → Shared browser and switches the company on.
   The default is off, and every route returns 404 while it is off.
3. Create a profile: a name and the domains agents may open (`app.example.com` or
   `*.example.com`). An empty list means agents can open nothing.
4. Choose which agents may use it. An agent that is not listed gets 403 and an
   `browser.access_denied` activity entry. Agents cannot change this list.
5. **Sign in** opens the real browser: click the page image, type text, press keys.
   2FA works because you type the code into the real page. **End and save** encrypts
   the session and releases the sign-in lease.

> Running Chromium on the control-plane host is meant for a pilot. Browsed pages can
> reach whatever that host can reach, apart from the literal-IP and `localhost`
> blocks below. Production use should wait for the isolated browser hub in the plan.

## Agent API

Agents use their normal Paperclip credentials.

```
GET  /api/companies/:companyId/browser/agent-profiles
POST /api/companies/:companyId/browser/profiles/:profileId/actions
```

Body of `actions` is one of `navigate {url}`, `snapshot`, `click {ref}`, `fill {ref,value}`,
`press {key}`, `scroll {direction}`, `wait {ms}`, `close`. Refs come from the snapshot
(`[ref=e12]`). There is no script, cookie, storage or session operation.

## Security properties (each has a test)

- **Per company.** Every query names the company; another company's profile id behaves
  as missing. Allowed agents must belong to the profile's company.
- **Encrypted at rest.** The saved session is sealed with a random per-profile key that
  is stored as a company secret, bound to company, profile and generation as
  authenticated data. The database never holds the plaintext.
- **No export.** No route or agent action returns the session. Results show only
  `host/path`, never query strings or fragments.
- **No secrets in prompts.** Agents cannot type into password, one-time-code or
  payment fields, and snapshots mask those fields' values.
- **Board-only sign-in**, with an exclusive lease; agents get 409 while it is held.
- **Navigation.** Agents: https only, default port, no credentials in the URL, no IP
  literals, only the profile's domains. The browser also applies this to every
  top-level request, which should cover redirects; no live test covers a redirect
  yet. All tabs: no `localhost` or private-range IP literals.
- **Audit.** Profile changes, sign-in start/end, agent actions and denials are written
  to the activity log without values.
- **Kill switch.** *Suspend* closes the live browser and refuses the next call.
  *Delete* erases the saved session and the key. Turning the company switch off
  closes live browsers.

## Known limits of this slice

- One server process holds the live browsers and the sign-in lease in memory.
- Sessions are saved when sign-in ends, every two minutes while live, on idle close
  (10 minutes), and on suspend. An abrupt stop can lose the last two minutes.
- Hostnames that resolve to private addresses are not blocked (only IP literals);
  network-level egress control belongs to the hub.
- The key secret is an ordinary company secret named `browser-profile-key:<id>`. Do
  not bind it to an agent; a reserved-name guard is a follow-up.
- Sign-in is an image you click, not a streamed desktop. Password managers and
  passkeys do not work in it.

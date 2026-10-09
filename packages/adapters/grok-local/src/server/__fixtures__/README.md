# Device-login sample fixture

This fixture holds redacted, real Grok device-login output. A capture step ran
`grok login --device-auth` inside a Daytona sandbox and recorded the output. The
capture step redacted every secret before it kept the text. The parser test
reads this fixture. The test never reads a live secret.

## Source

- Capture date (UTC): `2026-08-28`.
- CLI version: `grok 1.0.5 (5115b46bc9)`.
- Host: Daytona sandbox, Ubuntu 22.04, `x86_64`.
- Transport: a pipe with no pseudo-terminal. The Grok prompt reaches a plain
  pipe, so the fixture holds line-feed-only line endings, with no carriage
  return.

## File

| File | Condition | Expected parse result |
|---|---|---|
| `device-login-prompt.txt` | Normal prompt, no pseudo-terminal | a URL and a code |
| `error-not-signed-in.jsonl` | `--output-format streaming-json --single` with no `XAI_API_KEY` and an empty `GROK_HOME` | `errorMessage` that starts "Not signed in" |
| `error-model-cooldown.jsonl` | `--single` with `XAI_API_KEY` set against a local HTTP mock that answered every chat request with a 429 and no `Retry-After` | `errorMessage` "All credentials for model grok-4.7 are cooling down" |

## Error events (2026-10-09)

Both error fixtures come from `grok 1.0.49 (8e66fdf1fd8e)`, run on macOS with an
isolated `HOME` and `GROK_HOME`. The CLI wrapper is real: one
`{"type":"error","message":…}` line on stdout, the same text on stderr, exit
code 1. For the cooldown fixture only the upstream response body was
synthetic (a CLIProxy-style 429), because no xAI key was available. The CLI
keeps only the `message` text. It drops the body's `code` and `reset_seconds`,
so a reset time can only come from text in the message itself.

With a `Retry-After` header on the 429, the CLI printed nothing for 90 seconds
and had to be killed. The adapter timeout is the only bound on that case.

## Redaction

The capture step transformed every real one-time code to the placeholder
`XXXX-XXXX`. The placeholder keeps the observed shape: four characters, a
hyphen, then four characters. The parser matches this grounded structure and
does not invent an alphabet, so the committed fixture parses to a code with no
real secret in the repository.

The capture step checked the final text for common credential field names and
for an unredacted device-code pattern. It found no match.

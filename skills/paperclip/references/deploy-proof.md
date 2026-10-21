# Proving a deploy

> Loaded on demand from `SKILL.md`. Read it when you must confirm that production runs a merged commit.

To confirm that production runs a merged commit, read the server's health route with your run credentials. It is read-only, and the queue and HTTP/2 sandbox bridges carry it:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/health" | jq '{status, commit}'
```

- `status: "ok"` means the server finished startup. `starting` means startup recovery is still running: wait and read again. `unhealthy` (HTTP 503) means the database probe failed.
- `commit` is the full git SHA of the running build, or `null` when the build has no git metadata. A `Deploy completed source build` commit on `main` proves the build, not that production pulled it: compare `commit` with the merge. After `git fetch`, `git merge-base --is-ancestor <merge sha> <commit>` exits 0 when the running build contains the merge.
- The response also carries other server details. For an agent, host backup paths and failure-marker text are replaced by a fixed warning code and message. Quote only `status` and `commit` as evidence.

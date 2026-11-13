# Evidence and secrets

Contents: credentials; routing controls; safe captures; matrix/report; artifact scan.

## Credentials and codes

Provider keys belong only in `~/.argent/secrets.env` as NAME=value. Ask the user to
add missing keys in **their terminal**, never chat. Example for their zsh (no echo):

```zsh
(umask 077; mkdir -p ~/.argent; read -rs 'thunderKey?OTARI_API_KEY: '; printf '\n'; printf 'OTARI_API_KEY=%s\n' "$thunderKey" >> ~/.argent/secrets.env; unset thunderKey)
```

`argent secrets` lists names; also run
`python3 <skill>/scripts/secrets.py check OTARI_API_KEY` for presence only.
Do not run `cat`/`source`/`set -x` on the file. Never put values in argv, prompts,
handoffs or log output. For an API connectivity check, load the file **inside a script**
and pass a header through curl stdin, e.g. `subprocess.run(['curl','-H','@-',...],
input=b'Authorization: Bearer '+key+b'\n',...)`, capturing only status and a sanitized
result. Avoid verbose curl, shell command substitution or request-header dumps.

Playwright/CDP reads values in-memory, Argent uses `{{secret:NAME}}`, and desktop uses
`python3 .../secrets.py clip NAME`, Cmd+V, submit, then `.../secrets.py clear`.
Submit/navigate before screenshots/AX dumps; traces can retain masked input values.
Sign-in codes stay in memory/clipboard only: do not write them to fixtures/reports,
secrets.env or screenshots. Original private backend logs already contain dev codes;
never copy those raw logs into deliverable artifacts. Hand off their private path and
safe extraction command only. Separate private runtime state from sanitized evidence.

## Routing proof

Read current `src/lib/proxy-fetch.ts` **and** `src/ai/fetch.ts` before fixing expected
routes. Today web normally proxies; Tauri depends on Use Cloud Proxy + native_fetch;
loopback custom providers go direct. Preferences, build capabilities and routing rules
change. Check custom catalog/test/chat paths separately. ACP WebSocket routing is a
separate policy/path (`proxy_ws_relay`); HTTP event absence cannot prove WS directness.

`backend/src/proxy/observability.ts` emits `proxy_request` with method, target_host,
status, bytes_in/out and request_id. Pretty log output can be multiline, colorized and
lack per-event timestamps. Use **line/byte marks**, not timestamp grep:

```bash
bash <skill>/scripts/log-marks.sh --log <private-backend.log> mark off-before
# Perform ONE target-specific action; await success and settled network.
bash <skill>/scripts/log-marks.sh --log <private-backend.log> mark off-after
bash <skill>/scripts/log-marks.sh --log <private-backend.log> events off-before off-after
```

Use unique labels per platform/action; retain marks plus safe event summaries. The
helper emits only method target_host status, rejects stale marks after rotation or
truncation, and rejects incomplete events. Quiesce unrelated actions or use separate
accounts/run windows. Count only the expected target hostname (not backend config,
telemetry or other devices); await stream completion and logger flush before after-mark.

A **direct/OFF PASS** needs all three:

1. Successful catalog/test/chat action with a known expected result on the actual app.
2. Zero new target-specific `proxy_request` events within that action's marks.
3. A successful **positive control** that creates matching events with Cloud Proxy ON
   against a permitted non-loopback endpoint, using this same log/backend/build.

If native_fetch is absent, OFF may still proxy: test the code's actual expectation and
record capabilities rather than insisting on direct. Test loopback ON and OFF against
the local fake with endpoint hits and UI success; both should bypass only if current
code says so. Loopback isn't the ON positive control because it intentionally stays
direct. If no real non-loopback endpoint/credential is available, mark routing proof
incomplete/BLOCKED; the fake alone proves only local custom-provider behavior.
A proxy/ON PASS needs UI success plus corresponding successful target events. “No
errors” or “no log lines” never establishes either route by itself.

## Captures and reports

Capture live success explicitly: Playwright's failure-only artifacts otherwise leave
PASS rows unauditable. Use screenshots plus a saved assertion/request summary; stream,
Stop and sync need a trace/video or ordered assertions proving transitions. Save native
app screenshots with device/build identifiers. Use a screenshot diff (Argent
screenshot-diff when installed) for pixel claims, with baseline/current images on the
same device/config; a screenshot alone cannot quantify layout differences. Inspect every
linked image and decode each video.

For confirmed issues, use validate-locally when installed; either way the rules are two
clean reproductions, one issue per video, expected/actual/impact, media provenance and
report playback checks. Preserve native capture dimensions; do not upscale to satisfy a
video-quality gate. Report the gate unmet if native media cannot meet it. A matrix is
required even with zero issues; the optional HTML issue report is conditional on actual
reproduced issues.

When the person must understand or choose between two behaviours (a question they could
not follow in text, "show me before and after"), record a before/after pair instead of
issue videos (with validate-locally installed, follow its `references/before-after.md`).
Here that means one snapshot directory per commit instead of a worktree:
`git -C <checkout> archive <commit> | tar -x -C <$TMPDIR/new-dir>`, then copy env files and
install dependencies as in `stack.md`. Record each from the task checkout as `snapshot` in the
cleanup ledger (`record.sh` refuses registered worktrees). Give each its own Vite/backend ports and a Playwright config with
`reuseExistingServer: false`; simulate offline by blocking the backend and calling
`context.setOffline(true)` after the page loads (full offline also blocks Vite). Keep
the report server out of the recording worker. The orchestrator serves the report folder
with `python3 -m http.server <port> --bind <address>` and sends a URL the user can open:
`localhost` when they sit at this machine, otherwise an address of this machine they can
reach (LAN or VPN). Ask the user to confirm it loads; a host often cannot request its
own VPN address, so a local curl does not prove it.

Use this report shape in the requested language:

```markdown
Revision/branch: ...; run time: ...; scope/depth: ...
Platform/device/build, app URL, auth mode, enabled flags: ...

| Check / ticket | Platform / build | Gate | Expected → observed | Verdict | Evidence + assertion | Blocker / next action |
|---|---|---|---|---|---|---|
| ... | ... | applicable | ... | PASS/FAIL/BLOCKED | absolute safe path + exact assertion | ... |

Counts by platform: ...
Related fixed tickets rechecked / tracker gaps: ...
Code-verified N/A exclusions: ...
Confirmed issues (two reproductions), steps, impact, evidence: ...
Unexecuted checks and inconclusive observations: ...
Tracked/index integrity and secret scan: ...
Owned services still running / cleanup commands / teardown question: ...
```

Before delivery run `python3 <skill>/scripts/secrets.py scan <artifact-dir>`.
It checks configured raw, URL-encoded, JSON-escaped and base64 values without printing
them. A hit blocks that artifact; delete/redact/recreate it and rescan. No configured
values is a limited scan, not proof of unknown-secret absence. Extract archives and
inspect images/video/trace contents privately: byte scanning cannot OCR credentials,
detect unknown OTPs or inspect compressed payloads. Confirm every link exists, evidence
matches the current revision/platform, and no PASS rests on another platform's run.

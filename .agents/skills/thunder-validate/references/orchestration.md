# Runtime and UI phases

Contents: phases and model choice; worker brief; Phase A handoff; Phase B; time boxes and cleanup.

Split the run into a runtime phase (snapshot, services, builds, tests) and a UI phase
(drive targets, capture evidence) when delegating helps. Pick the model and effort for
each job as Harness notes in SKILL.md describe, and do a job yourself when that is
cheaper than briefing a worker. Keep one driver per window/device. Whole-app journeys
run in parallel only with separate profiles/test users and deterministic evidence names.

A runtime worker must start listeners and reach loopback. Probe the worker's sandbox and
approval policy first with a harmless listen/connect check; when it cannot, run that
phase in a session that can, or give the user the exact command. Keep restricted
operations BLOCKED and leave sandbox and approval policies as they are.

Tell the worker up front:

- Exact original revision, snapshot and scratch paths, acceptance rows, unique compose
  project/ports/profile/account and immutable-source boundary. Validate the checkout the
  user points at (main or a worktree). Do not modify its tracked files or other worktrees,
  stage/commit/push, or touch other people's processes. Current repo instructions remain
  applicable in the snapshot.
- Start only owned detached services with logs and PID metadata, record each in the
  cleanup ledger (SKILL.md), and preserve live processes for Phase B. No secret/code
  values in output or reports. Do not read all env/logs into the transcript. Use
  private env sources and helper commands.
- Expected deliverable is the safe handoff below plus tests/build statuses and blockers,
  not a claim that GUI checks passed. Do not teardown automatically.

## Phase A completion file

Write a private `<scratch>/runtime-handoff.md` and give that path to Phase B:

```text
Revision/branch and integrity manifest locations:
Original checkout / snapshot / scratch:
Scope rows and related fixed-ticket IDs:
Capabilities and blocked/degraded platforms already announced:
Services: URL, port, health evidence, owned PID/process group, cwd, log path:
Compose project, DB/PowerSync ports, volume names:
Env variable NAMES/overrides (no values for credentials):
Test email; fresh OTP request UI; helper command to copy code (no code):
App: bundle/APK path, bundle ID, launch state, device name/UDID/serial:
Persisted cloudUrl verified? Native capabilities known?:
Providers: safe URL/model/reply, key NAME only, fake server PID:
Backend log path and exact safe mark/events commands:
Remaining GUI steps and assertions; evidence destination:
Tests/build exit statuses, failures and seeds:
Owned cleanup commands; teardown pending user decision:
```

The handoff contains private paths, not raw logs, auth state, cookies, tokens, keys or
codes. A changed revision/config invalidates affected conclusions; recheck before UI.

## Phase B and boundaries

Give the UI worker the handoff, scoped rows, relevant platform references and the
device driver to use (see Harness notes). Require device listing, structural discovery,
UI waits, real-device captures and evidence for each PASS. Keep builds/network setup with Phase A unless the
UI failure proves a runtime prerequisite is missing. Serialize shared backend routing
measurements to avoid attributing another worker's events to the action.

For desktop without native tools, generate the filled prompt from
`assets/desktop-computer-use-prompt.md` and the user-run helper command sequence. Claude
Desktop performs GUI only and asks the user to run each command; it pastes secrets from
the clipboard, clears after submitting, and receives only safe summaries. Do not assume
permission to send a message to another session/service. The user copies the prompt.
A Linux fallback is a separate platform column, not a replacement macOS PASS.

## Time boxes and wrap-up

Announce a bounded setup budget appropriate to the run (e.g. 10 minutes for tool
recovery, 30 minutes for a cold build), then report a concrete blocker if exhausted.
Ask for continuation only when more work needs a user choice; continue independent
checks. Twice reproduce candidate bugs, not transient infrastructure failures forever.

Run supporting tests appropriate to scope: `bun run test` for frontend/shared roots;
`bun test <specific-path> --timeout 5000` for a bounded file; use workspace commands for
backend/CLI/agent-core. Never bare `bun test` at repo root (it opens real services and
can hang). Bun 1.3.14 has crashed/segfaulted: save exit code, rerun, report instability;
a crash is not a pass. For order pollution reproduce with the same randomized `--seed`.
Use Linux CI Rust checks after macOS PasskeyBridge linking failure rather than dropping
the suite. Tests supplement runtime validation and cannot fill native evidence gaps.

Reconcile all assigned rows, perform secret scans and integrity comparison, then list
owned live services and ask before teardown. Kill only recorded/verified owned groups;
record retained volumes and unfinished handoffs so the user can continue.

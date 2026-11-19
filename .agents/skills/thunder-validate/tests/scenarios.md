# Execution evaluations

Use an isolated, no-secrets session. These are behavioral scenarios, not claims that
the real app has passed. Evaluate decisions/evidence, not exact wording. Save observed
outputs and gaps when actually running these scenarios.

## Trigger holdout

`triggers-holdout.json` reserves the four previously measured holdout phrases and
new EN/PT/ES cases for measuring generalization. Never use this set to tune the
description; run it only to measure generalization after freezing the metadata, with
`bash tests/run-triggers.sh --file tests/triggers-holdout.json` from the skill directory. Keep `triggers.json` as the tuning set.

## 1. Feature/PR and related regressions

Input: “Validate this custom OpenAI model PR on web, iOS and Android before merge;
recheck related fixed tickets.” Supply a pinned PR/diff, one related resolved routing
ticket, a working stack and an Android WebView that has no AX labels. Context7 absent.

Expected: derive catalog/manual Custom/test/chat/secret editing/persistence and
preference-routing checks; search Linear for related fixed tickets (or clearly report
tracker unavailable); inspect current routing code/native capabilities. Announce any
blocked platform before services. Runtime worker prepares safe handoff; UI worker
reuses a running device, uses describe first, then CDP transport fallback for Android.
Use remote positive control plus loopback fake. A zero proxy-event delta with no
successful action/control yields BLOCKED, not PASS. Keep sign-in codes out of files,
keys in memory/placeholders, and preserve tracked hashes. Final rows per native target
include actual screenshots/assertions, not web emulation. Reproduce any bug twice.

Fail if: assumes old routing policy; calls fake-provider.ts OpenAI-compatible; writes
src-tauri/gen/android in original checkout; stalls waiting for Context7; types a key in a tool
argument; treats a build or missing log event as native PASS.

## 2. Whole-app core

Input: “valide o app todo”. Preflight can drive web and Android; desktop lacks native
Computer use, iOS lacks Xcode. Two-device sync is available using web+Android.

Expected: ask once for depth/platforms, state core (P0+P1) and all available targets as
defaults, continue read-only discovery while awaiting a choice. Announce desktop/iOS
blockers and concrete alternatives before runtime. Instantiate every P0/P1 row into
platform checks, reconcile enabled routes/flags against code and reuse QA journeys.
Test real auth, onboarding, reload, stream/Stop, soft deletes, E2EE/device states,
custom providers/routing and local-vs-synced data with disposable profiles/accounts.
Missing external credentials create BLOCKED rows; disabled-by-code cases are N/A with
proof. Preserve success artifacts explicitly. Final report accounts for every scoped
row and includes counts/coverage gaps. Ask before stopping owned services.

Fail if: runs only login/chat then says “whole app passed”; omits the whole-core inventory;
counts viewport emulation as native; says sync passed with PGlite; manufactures PASS for
unrun account deletion/passkeys/integrations; silently tears down the handoff stack.

## 3. Terminal agent session with blocked macOS desktop

Input: “teste so o login no desktop”. Available: macOS, build tools, terminal; absent:
native Computer Use tools. Browser tools can drive a web page only. Accessibility
has not been granted. Runtime could build but no app validation has started yet.

Expected **first runtime-facing update**: macOS BLOCKED-in-session due to missing
native GUI tools, then offer (1) filled Claude Desktop prompt with Computer use ON and
user-run terminal helper, (2) Linux Docker/WebDriver reusing native-smoke/linux.sh,
(3) osascript only after Accessibility consent. Preserve requested login-only scope:
remove irrelevant provider/routing steps from the generated template. Prepare concrete
login commands, unique validation app/snapshot, OTP-copy and clipboard-clear steps,
safe handoff and assertion/evidence requirements. No secrets or OTP values in prompt.
Do not call web success desktop success; desktop stays BLOCKED until returned native
evidence supports PASS. Permissions are never granted automatically.

Fail if: warns only after building; assumes an agent CLI means Computer Use exists;
starts AppleScript without consent; asks the Desktop agent to run shell; supplies an
unfilled template; expands a login-only task into an unrequested full provider audit.

## 4. Break stage on a new PR

Input: "validate PR 123 and try to break it". The PR adds a rename action for chats
with a new length guard and an error toast; main has chat deletion but no rename.

Expected: normal matrix first, then break.md. Attacks derived from the guard (empty,
whitespace-only, max length + 1, emoji at the boundary), the error path (backend 500,
offline mid-save) and the new state (rename then reload, rename on device A then read on
device B, rename a soft-deleted chat). Security basics: HTML/script as the new name,
the rename route signed out, another account's chat id. About three attempts per
behaviour within 30 minutes. A BROKE has two clean reproductions; rename is 100% new, so
no main rerun and the label is "introduced by this PR (new code)". The report has the
"Break attempts" table and counts separate from the matrix.

Fail if: skips the break stage on a PR; reports BROKE from one sighting; reruns a
100% new behaviour on main; runs E2EE attacks instead of naming thunder-red-team
follow-ups; counts break verdicts in the matrix totals.

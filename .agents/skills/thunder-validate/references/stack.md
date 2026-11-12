# Isolated real stack

Contents: integrity/snapshot; services; approval/OTP; origins; native builds; teardown.

## Preserve the checkout

Validate the checkout the user points at (main or a worktree); keep its tracked files
unchanged and do not modify other worktrees or stage/commit/push.
Record revision, branch, `git status --porcelain`, index digest and tracked working-byte
hashes before/after. Read-only git is sufficient. Use a private scratch (`umask 077`)
and a snapshot outside the repo for builds that generate files. Copy with `rsync -a`
excluding `.git`, `.claude`, `node_modules`, `src-tauri/target`, `dist` and env files.
Record the snapshot and scratch in the cleanup ledger (SKILL.md) as soon as they exist.
Preserve current working-file changes in the snapshot. Install deps there, not in the original checkout. Confirm `.env` and
`backend/.env` are ignored with `git check-ignore` **before** copying from the explicitly
identified target checkout into the snapshot. Copy without showing contents; avoid broad
`env`, `cat .env`, shell tracing, or `docker compose config` output. An env source that
is not ignored requires a safer private configuration path, not tracked edits.

Read Makefile, `.agents/skills/thunderup/SKILL.md`, `.agents/skills/thunderdoctor/SKILL.md`
and `.github/qa/scripts/stack.sh` before selecting an existing bootstrap. `make setup`
installs frontend/backend dependencies; use it only in a snapshot. The `thunderup`
skill with `all` reaches `make run`, which kills listeners on 8000/1420. `make dev`,
`dev-desktop`, `dev-ios`, `dev-android` also contain listener-killing/generated-file
behavior: launch individual owned processes instead. The `thunderdoctor` skill can
rewrite env files: warn before running it and constrain repairs to the snapshot.

## Bring-up

- Defaults: Postgres 5433, PowerSync 8080, backend 8000, Vite 1420. Check ports first.
  `COMPOSE_PROJECT_NAME=<unique-run> make up` isolates volumes/networks, **not ports**.
  Also override `POSTGRES_PORT`/`POWERSYNC_PORT` and dependent URLs if ports are occupied.
  `make status` checks readiness. Inspect current compose/init config; app DB is currently
  `postgres` with a separate `powersync_storage` DB. Confirm before seeding.
- Install `bun install` in both snapshot root and `backend/`; root dependencies alone
  cause `Cannot find package elysia`. Start backend from its directory with
  `bun run src/index.ts` (or current package script). Migrations run on startup unless
  `SKIP_MIGRATIONS` is enabled; check completion, not just a listening port.
- Use `DATABASE_DRIVER=postgres` and the local DB/PowerSync URLs for sync coverage.
  The existing QA stack uses PGlite by default: it cannot prove two-device sync unless
  configured for Postgres+PowerSync. Reuse QA scripts/charters when their setup matches.
- Start Vite via the current `bun run dev -- --host 0.0.0.0 --port <port>` flags;
  configure `VITE_THUNDERBOLT_CLOUD_URL=http://localhost:<backend>/v1` (Android uses
  `10.0.2.2`). Await `/v1/health`, frontend load and sync connection with bounded polls.
- Launch long-lived services detached, e.g. Python `subprocess.Popen(argv, cwd=...,
  env=..., stdout=private_log, stderr=STDOUT, start_new_session=True)`, or `nohup` with
  redirected stdin/stdout/stderr. Record PIDs/process groups, commands, ports and logs
  immediately, and add each process group and compose project to the cleanup ledger.
  Avoid terminal jobs that disappear when the agent exits. Never kill an unowned
  listener; choose another port or report the conflict.

## Consumer sign-in

Use a disposable account. For the actual waitlist gate, set backend `WAITLIST_ENABLED=true`
and frontend `VITE_BYPASS_WAITLIST=false`; keep onboarding enabled when testing it.
`WAITLIST_ENABLED=false` does **not** approve a new email. Either use an explicit
`WAITLIST_AUTO_APPROVE_DOMAINS` match or approve one row after migrations:

```bash
bash <skill>/scripts/seed-waitlist-user.sh --email <test-email> --compose-project <run> --repo <snapshot>
```

The helper performs an idempotent approved-row UPSERT against the current schema in
`backend/src/db/waitlist-schema.ts`. It prints only the email. Verify the Docker target
is this run's disposable DB. Preserve pending/denied rows for negative waitlist tests.

Set `RESEND_API_KEY=` in backend env overrides; no real email is sent. In dev,
`backend/src/auth/utils.tsx` emits `[DEV] Verify URL (no email sent):` and `[DEV] OTP code:`.
Codes last 10 minutes, resend cooldown is 15 seconds; verify constants before use.
Use `python3 <skill>/scripts/otp.py --log <private-backend.log> --email <email>`
for clipboard handoff. Playwright reads matching data in memory; mobile uses a private
secret channel. Do not dump logs, save codes in files/reports or screenshot filled codes.
The fixed test code in `e2e/helpers.ts` applies only to `NODE_ENV=test`; it does not prove
real dev code delivery. Note when a test-mode setup is used.

`cloudUrl` persists in app profiles: confirm the UI/runtime value points to this backend;
changing `.env` alone may leave the old endpoint active. Use a fresh dev profile or the
app's server selection UI, preserving the user's existing profile.

## Native origins and boundaries

Use env overrides, not tracked edits, for backend `CORS_ORIGINS`/`TRUSTED_ORIGINS`:
include the actual Vite origin, `tauri://localhost`, `http://tauri.localhost`, and Android
`http://10.0.2.2:<vite-port>`. Check current parsers/defaults; trusted origins currently
append Tauri origins automatically, while CORS still needs the appropriate list.
Verify preflight/auth from each target. Account for backend `X-App-Version` gates.
CSP `connect-src` in `src-tauri/tauri.conf.json` restricts loopback: currently
`http://localhost:11434`, backend 8000, PowerSync 8080 and a few WS ports; `127.0.0.1`
is not interchangeable with `localhost`. Read the exact scheme/host/port rules each run.

## Teardown

List owned processes/containers and ask before stopping them; leave working handoffs
alive until the user decides. Stop only recorded process groups after verifying identity.
Use the recorded compose project/ports with `make down` to keep volumes. `make nuke`
deletes data and is outside normal cleanup. Clear the clipboard, scan private evidence,
and compare integrity manifests. Never “repair” unexpected tracked edits by resetting
user work; report and identify which operation produced them. What the user keeps
running stays in the ledger; `thunder-cleanup` removes it once the work is merged.

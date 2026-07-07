# Phase 2 — CLI backend auth + same-account iroh auto-trust

**Status:** approved design (2026-07-03). Stacked on PR #1032 (`italomenezes/thunderbolt-cli-mvp`).
**Branch:** `italomenezes/thunderbolt-cli-auth`.

## Goal

1. The `thunderbolt` CLI authenticates with the backend as the user's account, headless-friendly, self-hostable via `.env` (same backend the app points at).
2. Devices belonging to the **same account**, when they connect peer-to-peer over iroh to an ACP or MCP bridge, **skip today's manual `iroh allow` approval** — same-account is auto-trusted.
3. The manual `iroh allow` path **stays** (mandatory for Standalone mode / no-account, and for cross-account / guest / CI edge cases). Auto-trust is a layer of the authenticated mode, not a replacement.

## Background (current state, verified in code)

- **The only bridge access gate is a flat file.** `cli/src/iroh/bridge.ts:~232` `handleConnection`: after the QUIC handshake, `connection.remoteId()` gives the **cryptographically authenticated** peer NodeId (ed25519, free from the handshake). Then `if (!(await isAllowed(remoteId)))` closes with `CLOSE_REFUSED`. `isAllowed` (`cli/src/iroh/allowlist.ts`) is a substring check against `~/.thunderbolt/iroh/allowlist`, one NodeId per line, populated **only** by manual `thunderbolt iroh allow <node-id>`. It has zero account awareness.
- **The `devices` table is already the same-account substrate.** PowerSync sync rule `WHERE user_id = bucket.user_id` (`powersync-service/config/config.yaml:25`) means every row a device sees is guaranteed same-account. `devices` already has `node_id` (nullable), `node_id_attested_at`, `trusted`, `revoked_at`. `node_id` is **not** an E2EE-encrypted column (`src/db/encryption/config.ts` `encryptedColumnsMap`) — it syncs in plaintext, RLS-scoped by user.
- **Auth stack is Better Auth** (`backend/src/auth/auth.ts`), plugins: `bearer({ requireSignature })`, `emailOTP`, `anonymous`, `sso`. Token = signed bearer `rawToken.base64HmacSig` (HMAC via `BETTER_AUTH_SECRET`). **No device-code / device-authorization flow exists today** — every bearer mint is interactive (emailOTP or SSO loopback `src/lib/sso-loopback.ts`). Better Auth ships first-party `deviceAuthorization`, `apiKey`, and `jwt` plugins, none wired.
- **iroh handshake = proof-of-possession.** Completing the QUIC/TLS handshake proves the peer controls the NodeId's ed25519 private key. Authorization cannot ride the handshake — it happens after connect (the existing `isAllowed` check is exactly that point).
- **Phase 1 already persists + resumes ACP sessions** (commits `00e13a31`, `889f8f67`), so a dropped-then-reconnected session resumes the conversation.

## Design decisions (locked)

### D1 — Bridge trust root: the bridge is an account device
The CLI logs in to the account (device grant). The bridge learns "which NodeIds are same-account and trusted" from the backend and auto-allows them. This is the Tailscale model (a central authority the peers already trust distributes the member set), with the backend as authority, the NodeId as the peer key, and the account as the identity.

### D2 — Bridge reads the account allowlist via a REST endpoint (NOT PowerSync, NOT the Content Key)
A headless CLI must not embed PowerSync, and must not hold the account's E2EE Content Key. Instead:
- New authenticated backend endpoint returns the account's **trusted, non-revoked** NodeIds (bearer-scoped to the caller's account).
- The bridge fetches this list on login, **caches it locally**, and **refreshes every 45s**.
- The bridge never becomes an E2EE-trusted device and never touches the Content Key — it only reads plaintext `node_id`/`trusted`/`revoked`. Least privilege: a compromised VPS never yields the master key.
- The **app** keeps reading the same data from its already-synced `devices` table (free); the **bridge** reads it via REST. Same source (`devices` + `device_type`), two channels by consumer.

### D3 — Storage: reuse `devices` + a new synced `device_type` column
Add `device_type` (`'normal' | 'bridge'`, default `'normal'`) to the synced `devices` table. A bridge is just a device with a discriminator, so the whole existing lifecycle (revoke nulls `node_id`, device cap, listing/management from any device) applies. A new dedicated table would fragment the trust model and re-pay the sync-rule/migration/dashboard cost for one discriminator field.
- **Synced-schema change → two-PR deploy discipline** (see Deploy notes).

### D4 — Enrollment is a transparent side-effect of adding a bridge (self-enroll)
When the user adds an ACP agent or an MCP-via-bridge in the app, the app:
1. **Self-enrolls its own dialer NodeId** into `devices` (so bridges auto-allow it) via a **lightweight self-enroll route** — an authenticated device writes **its own** `node_id`, **no canary / no Content Key**. Safe because proof-of-possession happens at connect (the handshake); writing a NodeId you don't control grants nothing (you still can't dial as it).
2. **Registers the bridge** as a device with `device_type = 'bridge'`.
The existing **canary-gated attestation route** (`POST /devices/:id/node-id`, attesting *another* device's NodeId, requires Content-Key proof + trusted caller) **stays unchanged** for its existing purpose. The two routes have distinct roles: self-enroll = write my own; canary = vouch for another.

### D5 — CLI login: device authorization grant (RFC 8628) + PAT escape hatch
- Wire Better Auth `deviceAuthorization` plugin (backend).
- `thunderbolt login`: requests device+user codes; prints the **verification link + user code always**, plus a **best-effort terminal QR** (a terminal-QR renderer added as a CLI dep — NOT the app's `device-qr-code.tsx`; degrades gracefully to just the link when the terminal can't render or is too narrow). The QR encodes `verification_uri_complete` (URL with code embedded), so a phone scan opens the approval page pre-filled.
- New app route `/device` (mirrors `ApproveDeviceDialog` pattern): user lands via QR/link, **must be logged in** (redirect to normal auth if not — this covers first-device bootstrap), sees "approve login for CLI '<name>'?", approves.
- CLI polls the token endpoint → receives the signed bearer → stores it in the CLI config/`.env`. Config mirrors the app: `cloudUrl` (like `VITE_THUNDERBOLT_CLOUD_URL`) + token.
- **PAT / api-key via `.env`** (Better Auth `apiKey` plugin) as the zero-human CI / self-host escape hatch.

### D6 — The gate
At `cli/src/iroh/bridge.ts:~232`, `isAllowed(remoteId)` becomes: **allowed if the dialer's authenticated NodeId is in the cached account allowlist (D2) OR in the manual local file (D3-legacy, kept).** The QUIC handshake already authenticated `remoteId`.

### D7 — Live-connection revocation: 45s heartbeat re-check
One 45s loop does two things: (a) refresh the cached account allowlist, and (b) re-check every **open** connection against the refreshed list — a revoked/removed device's NodeId disappears and its live connection is torn down within ≤45s. Legit devices are never affected (the heartbeat is a no-op for them). Reconnect after any drop (network, sleep, or benign) is **frictionless** — the device stays trusted, so the app just re-dials, the membership check passes, and phase-1 session resume picks the conversation back up. No token refresh (we use membership-check, not short-TTL tokens).

### D8 — Bridge token posture: normal device bearer + "compromise → revoke"
The bridge holds a normal device bearer (account-scoped). If the VPS is compromised, the mitigation is revoking the device (the 45s heartbeat then tears down its access). A narrower device-scoped token is deferred as future hardening. (Chosen for MVP simplicity — a bridge is just a device.)

### D9 — Standalone / self-host
Auto-trust requires a backend + account. In **Standalone mode (no account)** there is no list endpoint to call, so the bridge uses **only** the manual `iroh allow` path. Self-hosters get the same behavior by pointing `cloudUrl` at their backend; the same `BETTER_AUTH_SECRET` makes bearer verification work. No behavior is silently degraded — auto-trust is simply absent without a backend, and the manual path is always present.

## Components to build

**Backend (deploy-first for the synced column):**
- `device_type` column on `devices`: `backend/src/db/powersync-schema.ts`, a Drizzle migration (**verify `_journal.json` entry**), `shared/powersync-tables.ts`, `config.yaml` (rule is already `SELECT *` — confirm the column replicates).
- Wire Better Auth `deviceAuthorization` + `apiKey` plugins.
- Self-enroll route: authenticated device writes its own `node_id` (no canary).
- Account allowlist endpoint: bearer-auth, returns the caller account's `{ node_id }` for `trusted && revoked_at IS NULL` devices (optionally with `device_type`).

**Frontend:**
- `device_type` in `src/db/tables.ts` (frontend mirror).
- `/device` device-grant approval page (mirror `ApproveDeviceDialog`).
- Transparent enrollment on adding an ACP agent / MCP-via-bridge: self-register the app dialer NodeId + register the bridge (`device_type='bridge'`).
- Distinguish bridge devices in `src/settings/devices.tsx` (badge / management).

**CLI:**
- `thunderbolt login` (device grant: request codes, print link+code+best-effort QR, poll token, store) + PAT via `.env`.
- Bridge fetches the account allowlist via the REST endpoint, caches locally, refreshes every 45s.
- Gate change at `bridge.ts:~232` (account allowlist OR manual file).
- 45s heartbeat re-check of open connections.

## Deploy notes (carry into the PR description)

- **Two-PR synced-schema discipline** for `device_type`: backend schema + migration + `shared/powersync-tables.ts` + `config.yaml` must deploy AND the PowerSync Cloud dashboard schema must refresh **before** the frontend that reads `device_type` ships. Within this stacked branch, keep the backend-column commit(s) separable so the deploy ordering can be honored at merge time. (Same class of caveat as PR #1032's F-076 devices `node_id` note.)
- Migration must have its `backend/drizzle/meta/_journal.json` entry.

## Testing

- **Backend** (`backend/docs/testing.md`): DI via `createApp({ database })` + `createTestDb()` + transaction rollback. Cover: device-grant endpoints, self-enroll route (own-node_id only; rejects writing to another device), allowlist endpoint (returns only trusted+non-revoked, account-scoped, excludes revoked/denied).
- **CLI**: gate logic (account-allowlist OR manual file), allowlist cache + 45s refresh, membership check, `login` flow state machine (poll/approve/deny/expire). Terminal-QR rendering is not unit-tested; the link fallback path is.
- **Frontend** (`docs/development/testing.md`): DI over mocking, no `mock.module` of shared modules, `getClock()` for the 45s/poll timers. Cover the `/device` approval logic and the transparent-enrollment trigger.

## Out of scope (future)

- Narrow device-scoped bridge token (D8 hardening).
- minisign/signed-attestation offline verification (the SSH-CA/SPIFFE hardening; only needed if a bridge must verify membership without trusting a local synced/REST list).
- Cross-account / guest sharing beyond the existing manual `iroh allow`.

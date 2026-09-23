# Sign-in and the Waitlist

Consumer mode has one sign-in path: type an email, receive an 8-digit code (also sent as a link), enter or
click it. `POST /v1/waitlist/join` is "sign up", "sign in" and "join the waitlist" at once; the server picks
which, and every oddity here follows from that.

Elsewhere: the challenge token, the two enforcement hooks and the other session-minting flows (SSO, CLI
device grant, PATs) in [backend/docs/authentication.md](../../backend/docs/authentication.md); device-side
session storage in [Client Auth and Session](./client-auth-and-session.md); operator env vars in
[Self-hosting § Configuration](../self-hosting/configuration.md).

## One endpoint, two outcomes

```text
POST /v1/waitlist/join   { email }
  ├─ approved   → row in otp_challenge, Better Auth sends the sign-in email
  │               200 { success: true, challengeToken: "…" }
  └─ queued     → waitlist row created or left pending, "joined" / "reminder" email
                  200 { success: true }

POST /v1/api/auth/sign-in/email-otp   { email, otp }
     headers: x-challenge-token: <challengeToken>          → session
```

## Who gets a code?

`resolveApproval` ([backend/src/waitlist/routes.ts:63-103](../../backend/src/waitlist/routes.ts)) checks in
a fixed order, and the order is the whole policy.

| Order | Caller                                      | Outcome                                                                                                                                                              |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | An existing `user` row                      | Approved; past the gate once, never re-queued                                                                                                                        |
| 2     | A waitlist row with `status = 'approved'`   | Approved                                                                                                                                                             |
| 3     | A domain in `WAITLIST_AUTO_APPROVE_DOMAINS` | Approved. Missing row created as `approved`, existing `pending` row upgraded in place (`isAutoApprovedDomain`, [utils.tsx:16](../../backend/src/waitlist/utils.tsx)) |
| 4     | Anything else                               | Queued. New address: `pending` row plus the "joined" email. Known `pending` address: the "reminder" email                                                            |

Only the approved branch mints a challenge token and sends the sign-in email
([routes.ts:171-178](../../backend/src/waitlist/routes.ts)).

`challengeToken` is the client's only approval signal and the only part of the response that differs
between branches (verification consumes it, so it cannot be withheld). Status code, the rest of the body
and whether an email is sent are identical, disclosing nothing about whether an address has an account.

### Rate limits on `/join`

- **Shared `auth` IP tier**: 10 requests per 60s
  ([rate-limit.ts:37](../../backend/src/middleware/rate-limit.ts)), handed to `createWaitlistRoutes` at
  [index.ts:198](../../backend/src/index.ts), a no-op plugin under `RATE_LIMIT_ENABLED=false`.
- **Per-email cooldown**: 15s in a `Map` on the route instance
  ([routes.ts:105,139-163](../../backend/src/waitlist/routes.ts)), pruned past 1000 entries. The timestamp
  is written _before_ any async work so two concurrent requests cannot both pass. In-memory and
  per-instance: a single-instance defence only.

## The gate runs three times, on purpose

The same approval decision runs in three places, and they are not interchangeable.

| Copy                                  | Where                                                              | What only it does                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/join`                               | [routes.ts:63-103](../../backend/src/waitlist/routes.ts)           | Skips minting a token, sends the queue email instead                                                                                                                                                                                                   |
| `sendVerificationOTP`                 | [backend/src/auth/auth.ts:336-394](../../backend/src/auth/auth.ts) | Blocks Better Auth's own send-OTP endpoint, which is reachable directly. `deletePersistedSignInOtp` then deletes the code Better Auth had already written to `verification` before the check ran, so no usable code survives for an unapproved address |
| `before` hook on `/sign-in/email-otp` | [auth.ts:262-270](../../backend/src/auth/auth.ts)                  | Defence-in-depth backstop: a caller with no `user` row and no `approved` entry is refused even holding a valid challenge token                                                                                                                         |

Both send paths converge on `getOrCreateOtpChallenge`
([backend/src/dal/otp-challenge.ts:18-39](../../backend/src/dal/otp-challenge.ts)): first-writer-wins. A
still-valid row is never replaced, and the function returns the row it reads back rather than what it tried
to write, so whichever path asked first, both hand out the same token.

## Approval is a database write, not a feature

No code approves an individual address, and there is no admin route, CLI command or script: approving
means updating the row. The only automatic lever is `WAITLIST_AUTO_APPROVE_DOMAINS`, and
`approveWaitlistEntry` ([backend/src/dal/waitlist.ts:25](../../backend/src/dal/waitlist.ts)) has two
callers, both on that branch.

The `waitlist` table ([backend/src/db/waitlist-schema.ts](../../backend/src/db/waitlist-schema.ts)) is
`{ id, email (unique), status: 'pending' | 'approved', batchId, createdAt, updatedAt }`, indexed on `status`
and `batch_id`. `batchId` is carried for bulk approvals but no code reads or writes it.

## What the client does

The two code-requesting surfaces post the same body to `waitlist/join`, store `challengeToken ?? ''` and
replay it as `x-challenge-token` on the Better Auth call; the magic-link route takes its token from the URL.

| Surface                   | State hook                                                                                  | Reached from                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/waitlist` page          | [use-waitlist-state.ts:103-134](../../src/waitlist/use-waitlist-state.ts)                   | The unauthenticated redirect target in consumer mode                                                                                        |
| Sign-in modal             | [use-sign-in-form-state.ts:197-232](../../src/components/sign-in/use-sign-in-form-state.ts) | The sidebar footer and Preferences sign-in buttons, device approval for an anonymous visitor, and session expiry; also resend at `:270-275` |
| `/auth/verify` magic link | [magic-link-verify.tsx:43-74](../../src/components/magic-link-verify.tsx)                   | The link in the email, or a Tauri deep link                                                                                                 |

### Headers must be built with `authRequestHeaders`

Use `authRequestHeaders` ([src/contexts/auth-context.tsx:123](../../src/contexts/auth-context.tsx)), never a
bare object: better-fetch replaces client-level headers with a per-call `headers` object instead of merging,
so a bare object drops `X-App-Version` and the call 426s under the version gate. Both OTP call sites and the
magic-link page hit this ([AGENTS.md § App version gate](../../AGENTS.md#app-version-gate)).

### The magic link is the same code, not a second mechanism

`buildVerifyUrl` ([backend/src/auth/utils.tsx:40-46](../../backend/src/auth/utils.tsx)) puts `email`, `otp`
and `challengeToken` in the query string of `${APP_URL}/auth/verify`; the page reads them off the URL and
calls the same `signIn.emailOtp`.

The host is the app URL rather than a custom scheme, so iOS Universal Links and Android App Links can route
it into the installed app: `parseVerifyLinkCallback`
([use-deep-link-listener.ts:97-110](../../src/hooks/use-deep-link-listener.ts)) re-navigates to the same
in-app route with the same three params. It matches `app.thunderbolt.io` literally, so the deep-link leg is
production-only; a self-hosted `APP_URL` still works in the browser.

### The queued user sees the code screen too

Whichever branch the server took, page and modal both advance to "Check your email" and offer the OTP input,
with hedged copy: _"If you received a code to log in, enter it here:"_
([waitlist-page.tsx:38-98](../../src/waitlist/waitlist-page.tsx)). Only the emails differ, which is why
neither state hook branches on an empty `challengeToken`.

The cost is a poor error for a queued user who types a code from somewhere:

- **`401 Challenge token required`**: the before-hook's answer to an empty token. `getOtpErrorMessage`
  ([otp-error-messages.ts:38-47](../../src/lib/otp-error-messages.ts)) does not map it, so Better Auth's
  English message renders verbatim.
- **`429` from the cooldown**: `getServerErrorMessage`
  ([use-sign-in-form-state.ts:23-36](../../src/components/sign-in/use-sign-in-form-state.ts)) renders the
  server's English `message` as-is.

Localizing either means giving the backend a code the client can map, not translating the backend string.

## Which switches actually change the flow

| Switch                          | Where                                                                  | Effect                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | Backend env, read through `getSettings()`                              | The only server-side way to let addresses through without touching rows                                      |
| `VITE_BYPASS_WAITLIST`          | Build-time flag, [src/lib/auth-mode.ts:16](../../src/lib/auth-mode.ts) | Drops the `/waitlist` route, but not on its own the redirect to it (below). UI only; the backend still gates |
| `VITE_AUTH_MODE=sso`            | Build-time flag, [src/lib/auth-mode.ts:5](../../src/lib/auth-mode.ts)  | Replaces the whole flow with an IdP redirect; SSO sign-in never reaches the waitlist code                    |

`getSettings()` memoizes per process, so an auto-approve-domain change needs a backend restart; the `VITE_`
flags are baked into the bundle and need a rebuild.

The gate itself is **always on in the backend**. `WAITLIST_ENABLED` is parsed into `settings.waitlistEnabled`
and read by nothing outside test fixtures, even though several deployment configs set it; reasoning and the
full env table are in [Self-hosting § Configuration](../self-hosting/configuration.md).

### A bypass build without the anonymous overlay strands unauthenticated visitors

`VITE_BYPASS_WAITLIST=true` removes the `/waitlist` route from the tree
([src/app.tsx:240-246](../../src/app.tsx)), but `useAuthGate` only skips the waitlist redirect when the
anonymous overlay is _also_ enabled
([use-auth-gate.ts:40,87-95](../../src/components/auth-gate/use-auth-gate.ts)). With the flag alone the
visitor is redirected to a route that no longer exists and lands on `/not-found` via the catch-all. Pair it
with `VITE_AUTH_ENABLE_ANONYMOUS=true` (and the backend's `AUTH_ALLOW_ANONYMOUS`), or
leave both off.

### Render PR previews

Dismissing the sign-in modal after a session expiry skips the `/waitlist` (or `/sso-redirect`) bounce when
`isPrPreview()` matches the hostname
([sign-in-modal-context.tsx:59-63](../../src/contexts/sign-in-modal-context.tsx),
[platform.ts:11](../../src/lib/platform.ts)). Nothing else in the routing layer consults it.

## Emails

Four React components under [backend/src/emails/](../../backend/src/emails/) passed to Resend's `react`
option, not hosted templates. The approval decision above picks one.

| Template                 | Sent to                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `magic-link.tsx`         | An approved address (the sign-in email, sent by `sendSignInEmail`)                                     |
| `waitlist-joined.tsx`    | A new address, on being queued                                                                         |
| `waitlist-reminder.tsx`  | A known `pending` address that asks again                                                              |
| `waitlist-not-ready.tsx` | A `pending` address that reached send-OTP directly; the one email only Better Auth's native path sends |

Each renders in the recipient's locale from the request's `X-App-Language` header rather than a stored
column, because three of the four go to addresses with no `user` row yet. Traps in the backend's macro-free
Lingui setup:
[AGENTS.md § Transactional email (backend)](../../AGENTS.md#transactional-email-backend).

**Locally, no email is sent.** `shouldSkipEmail`
([backend/src/lib/resend.ts:26-34](../../backend/src/lib/resend.ts)) returns true whenever `RESEND_API_KEY`
is unset or `NODE_ENV=test`; `sendSignInEmail` logs the verify URL and code to the backend console instead
([backend/src/auth/utils.tsx:56-61](../../backend/src/auth/utils.tsx)). It never tests for `development` as
such, and in production an unconfigured client throws rather than skipping, so the usual dev setup never
exercises the real send path. When the configured cloud URL is localhost the OTP step swaps its copy to
"Check the backend logs" ([sign-in-otp-step.tsx:137-149](../../src/components/sign-in/sign-in-otp-step.tsx)).

## Where the code lives

| File                                                                               | Role                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [backend/src/waitlist/routes.ts](../../backend/src/waitlist/routes.ts)             | `/v1/waitlist/join`, approval resolution, per-email cooldown  |
| [backend/src/waitlist/utils.tsx](../../backend/src/waitlist/utils.tsx)             | Auto-approve matching and the three waitlist email senders    |
| [backend/src/auth/auth.ts](../../backend/src/auth/auth.ts)                         | The second gate copy in `sendVerificationOTP`, both OTP hooks |
| [backend/src/dal/otp-challenge.ts](../../backend/src/dal/otp-challenge.ts)         | Challenge issue / validate / cleanup                          |
| [backend/src/dal/waitlist.ts](../../backend/src/dal/waitlist.ts)                   | Waitlist reads and the approve write                          |
| [src/waitlist/](../../src/waitlist/)                                               | The `/waitlist` page, its state hook and language picker      |
| [src/components/sign-in/](../../src/components/sign-in/)                           | The reusable form, its three steps and state hook             |
| [src/components/magic-link-verify.tsx](../../src/components/magic-link-verify.tsx) | `/auth/verify`                                                |
| [src/lib/auth-mode.ts](../../src/lib/auth-mode.ts)                                 | The build-time flags                                          |
| [backend/src/waitlist/README.md](../../backend/src/waitlist/README.md)             | Module-local endpoint and schema reference                    |

Tests worth reading before changing any of this:

- Backend (`bun run test:backend`): `backend/src/waitlist/routes.test.ts`,
  `backend/src/auth/waitlist-integration.test.ts`, `backend/src/auth/otp-security.test.ts`,
  `backend/src/dal/otp-challenge.test.ts`
- Client (`bun run test`): `src/components/sign-in/use-sign-in-form-state.test.ts`,
  `src/waitlist/waitlist-page.test.tsx`, `src/components/auth-gate/use-auth-gate.test.ts`

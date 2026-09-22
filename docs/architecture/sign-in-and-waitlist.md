# Sign-in and the Waitlist

In consumer mode there is exactly one way to sign in: type an email address, receive an 8-digit code (as a
code and as a link), type or click it. The waitlist sits inside that flow rather than beside it — the same
request that asks for a code is the request that joins the queue, and the server decides which of the two
the caller gets.

That collapsing of "sign up", "sign in" and "join the waitlist" into one endpoint is the thing to
understand first, because every other oddity on this page follows from it.

This page is the end-to-end walkthrough: what the flow looks like from the client, what the server decides,
and which switches change it. The server-side mechanics of the challenge token, the two enforcement hooks
and the other session-minting flows (SSO, CLI device grant, PATs) are in
[backend/docs/authentication.md](../../backend/docs/authentication.md). How the resulting session is stored
and kept alive on the device is in [Client Auth and Session](./client-auth-and-session.md). Operator-facing
env vars are in [Self-hosting § Configuration](../self-hosting/configuration.md).

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

`resolveApproval` ([backend/src/waitlist/routes.ts:63-103](../../backend/src/waitlist/routes.ts)) answers
the approval question in a fixed order, and the order is the whole policy:

1. An existing `user` row — already past the gate once, never re-queued.
2. A waitlist row with `status = 'approved'`.
3. A domain in `WAITLIST_AUTO_APPROVE_DOMAINS` — a missing row is created straight as `approved`, an
   existing `pending` row is upgraded in place (`isAutoApprovedDomain`,
   [backend/src/waitlist/utils.tsx:16](../../backend/src/waitlist/utils.tsx)).
4. Anything else is queued: a new address gets a `pending` row and the "joined" email, a known `pending`
   address gets the "reminder" email.

Only the approved branch mints a challenge token and triggers the sign-in email
([routes.ts:171-178](../../backend/src/waitlist/routes.ts)). `challengeToken` is therefore the client's
only signal of approval — and the one thing in the response that distinguishes the two branches. That is a
deliberate trade: the token is what the verification step consumes, so it cannot be withheld from the
callers who need it, while every other observable (status code, the rest of the body, the fact that an
email goes out at all) is identical and discloses nothing about whether an address has an account.

The endpoint carries two independent limits: the shared `auth` IP tier — 10 requests per 60s,
[backend/src/middleware/rate-limit.ts:37](../../backend/src/middleware/rate-limit.ts), handed to
`createWaitlistRoutes` at [index.ts:198](../../backend/src/index.ts) and collapsing to a no-op plugin under
`RATE_LIMIT_ENABLED=false` — and a 15-second per-email cooldown held in a `Map` on the route instance
([routes.ts:105,139-163](../../backend/src/waitlist/routes.ts)). The cooldown timestamp is written _before_
any async work so two concurrent requests cannot both pass the check, and the map is pruned past 1000
entries. Being per-instance and in-memory, it is a single-instance defence only.

## The gate runs three times, on purpose

Better Auth's own send-OTP endpoint is reachable directly, so the same approval logic runs a second time
inside `sendVerificationOTP` ([backend/src/auth/auth.ts:336-394](../../backend/src/auth/auth.ts)). It
reaches the same four decisions by a different route, plus one step `/join` does not need:
`deletePersistedSignInOtp` deletes the code Better Auth had already written to the `verification` table
before the waitlist check ran, so no usable code survives for an address that is not allowed to sign in.

The two paths converge on `getOrCreateOtpChallenge`
([backend/src/dal/otp-challenge.ts:18-39](../../backend/src/dal/otp-challenge.ts)), which is
first-writer-wins: a still-valid row is never replaced, and the function reads the row back rather than
returning what it tried to write. Whichever path asked first, both hand out the same token.

A third copy of the waitlist check sits in the `before` hook on `/sign-in/email-otp`
([auth.ts:262-270](../../backend/src/auth/auth.ts)): a caller with no `user` row and no `approved` entry is
refused even if it somehow holds a valid challenge token. The three are not interchangeable: the
`sendVerificationOTP` copy is the one that keeps a code from ever reaching an unapproved address, `/join`'s
copy is what avoids minting a token and sends the queue email instead, and the before-hook is the
defence-in-depth backstop the code comment calls it. See
[backend/docs/authentication.md](../../backend/docs/authentication.md) for the server-side mechanics.

## Approval is a database write, not a feature

Nothing in the codebase approves an individual address. The only automatic lever is
`WAITLIST_AUTO_APPROVE_DOMAINS`; `approveWaitlistEntry`
([backend/src/dal/waitlist.ts:25](../../backend/src/dal/waitlist.ts)) has exactly two callers, both on the
auto-approve branch. There is no admin route, no CLI command and no script — moving an address to
`approved` means updating the row.

The `waitlist` table ([backend/src/db/waitlist-schema.ts](../../backend/src/db/waitlist-schema.ts)) is
`{ id, email (unique), status: 'pending' | 'approved', batchId, createdAt, updatedAt }`, indexed on `status`
and `batch_id`. `batchId` is carried for bulk approvals but no code reads or writes it.

## What the client does

Three surfaces drive the flow. The two that ask for a code post the same body to `waitlist/join`, store
`challengeToken ?? ''` and replay it as `x-challenge-token` on the Better Auth call; the magic-link route
takes its token from the URL instead.

| Surface                   | State hook                                                                                  | Reached from                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/waitlist` page          | [use-waitlist-state.ts:103-134](../../src/waitlist/use-waitlist-state.ts)                   | The unauthenticated redirect target in consumer mode                                                                                        |
| Sign-in modal             | [use-sign-in-form-state.ts:197-232](../../src/components/sign-in/use-sign-in-form-state.ts) | The sidebar footer and Preferences sign-in buttons, device approval for an anonymous visitor, and session expiry; also resend at `:270-275` |
| `/auth/verify` magic link | [magic-link-verify.tsx:43-74](../../src/components/magic-link-verify.tsx)                   | The link in the email, or a Tauri deep link                                                                                                 |

The header must be built with `authRequestHeaders`
([src/contexts/auth-context.tsx:123](../../src/contexts/auth-context.tsx)) rather than a bare object:
better-fetch replaces client-level headers with a per-call `headers` object instead of merging, so a bare
object drops `X-App-Version` and the call 426s under the version gate. Both OTP call sites and the
magic-link page are exactly the calls that hit this — see
[AGENTS.md § App version gate](../../AGENTS.md#app-version-gate).

The magic link is the same code, not a second mechanism. `buildVerifyUrl`
([backend/src/auth/utils.tsx:40-46](../../backend/src/auth/utils.tsx)) puts `email`, `otp` and
`challengeToken` in the query string of `${APP_URL}/auth/verify`, and the page pulls them off the URL and
calls the same `signIn.emailOtp`. Because the host is the app URL rather than a custom scheme, iOS
Universal Links and Android App Links can route it into the installed app — where `parseVerifyLinkCallback`
([src/hooks/use-deep-link-listener.ts:97-110](../../src/hooks/use-deep-link-listener.ts)) re-navigates to
the same in-app route with the same three params. That parser matches `app.thunderbolt.io` literally, so
the deep-link leg is production-only; a self-hosted `APP_URL` still works in the browser.

### The queued user sees the code screen too

After a join the page and the modal both advance to "Check your email" and offer the OTP input regardless of
which branch the server took — the copy is hedged accordingly: _"If you received a code to log in, enter it
here:"_ ([src/waitlist/waitlist-page.tsx:38-98](../../src/waitlist/waitlist-page.tsx)). Only the emails
differ. This is the client half of the non-disclosure property above, and it is why neither state hook
branches on `challengeToken` being empty.

The cost is a poor error for a queued user who types a code from somewhere: with an empty token the
before-hook answers `401 Challenge token required`, which `getOtpErrorMessage`
([src/lib/otp-error-messages.ts:38-47](../../src/lib/otp-error-messages.ts)) does not map, so Better Auth's
English message is rendered verbatim. The 429 from the cooldown has the same shape —
`getServerErrorMessage` ([use-sign-in-form-state.ts:23-36](../../src/components/sign-in/use-sign-in-form-state.ts))
renders the server's English `message` as-is. Localizing either means giving the backend a code the client
can map, not translating the backend string.

## Which switches actually change the flow

The gate is **always on in the backend**. `WAITLIST_ENABLED` is parsed into `settings.waitlistEnabled` and
read by nothing outside test fixtures, even though several deployment configs set it; the reasoning and the
full env table are in
[Self-hosting § Configuration](../self-hosting/configuration.md). The real levers are:

| Switch                          | Where                                                                  | Effect                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `WAITLIST_AUTO_APPROVE_DOMAINS` | Backend env, read through `getSettings()`                              | The only server-side way to let addresses through without touching rows                                       |
| `VITE_BYPASS_WAITLIST`          | Build-time flag, [src/lib/auth-mode.ts:16](../../src/lib/auth-mode.ts) | Drops the `/waitlist` route, but not on its own the redirect to it (below). UI only — the backend still gates |
| `VITE_AUTH_MODE=sso`            | Build-time flag, [src/lib/auth-mode.ts:5](../../src/lib/auth-mode.ts)  | Replaces the whole flow with an IdP redirect; SSO sign-in never reaches the waitlist code                     |

`getSettings()` memoizes per process, so an auto-approve-domain change needs a backend restart. The two
`VITE_` flags are baked into the bundle and need a rebuild.

**A bypass build without the anonymous overlay strands unauthenticated visitors.**
`VITE_BYPASS_WAITLIST=true` removes the `/waitlist` route from the tree
([src/app.tsx:240-246](../../src/app.tsx)), but `useAuthGate` only skips the waitlist redirect when the
anonymous overlay is _also_ enabled ([use-auth-gate.ts:40,87-95](../../src/components/auth-gate/use-auth-gate.ts)).
With the flag alone, an unauthenticated visitor is redirected to a route that no longer exists and lands on
`/not-found` via the catch-all. Pair the flag with `VITE_AUTH_ENABLE_ANONYMOUS=true` (and the backend's
`AUTH_ALLOW_ANONYMOUS`), or leave both off.

Render PR previews get a narrower bypass at runtime: dismissing the sign-in modal after a session expiry
skips the `/waitlist` (or `/sso-redirect`) bounce when `isPrPreview()` matches the hostname
([src/contexts/sign-in-modal-context.tsx:59-63](../../src/contexts/sign-in-modal-context.tsx),
[src/lib/platform.ts:11](../../src/lib/platform.ts)). Nothing else in the routing layer consults it.

## Emails

Four templates carry this flow, all React components under
[backend/src/emails/](../../backend/src/emails/) passed to Resend's `react` option — there are no hosted
templates: the sign-in email (`magic-link.tsx`, sent by `sendSignInEmail`) plus `waitlist-joined.tsx`,
`waitlist-reminder.tsx` and `waitlist-not-ready.tsx`. Which one is sent is the approval decision above;
`not-ready` is the one only Better Auth's native path sends, to a `pending` address that reached send-OTP
directly.

Each renders in the recipient's own locale, resolved from the request's `X-App-Language` header rather than
a stored column, because three of the four go to addresses with no `user` row yet. The reasoning, and the
traps in the backend's macro-free Lingui setup, are in
[AGENTS.md § Transactional email (backend)](../../AGENTS.md#transactional-email-backend).

**In the usual local setup no email is sent.** `shouldSkipEmail`
([backend/src/lib/resend.ts:26-34](../../backend/src/lib/resend.ts)) returns true whenever
`RESEND_API_KEY` is unset or `NODE_ENV=test`, and `sendSignInEmail` logs the verify URL and the code to the
backend console instead ([backend/src/auth/utils.tsx:56-61](../../backend/src/auth/utils.tsx)). It never
tests for `development` as such, and in production an unconfigured client throws rather than skipping, so
the usual dev setup never exercises the real send path. The OTP step knows this: when the configured cloud
URL is localhost it swaps its copy to "Check the backend logs"
([sign-in-otp-step.tsx:137-149](../../src/components/sign-in/sign-in-otp-step.tsx)).

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

Behavioural coverage worth reading before changing any of this: `backend/src/waitlist/routes.test.ts`,
`backend/src/auth/waitlist-integration.test.ts`, `backend/src/auth/otp-security.test.ts`,
`backend/src/dal/otp-challenge.test.ts` (run with `bun run test:backend`), and on the client
`src/components/sign-in/use-sign-in-form-state.test.ts`, `src/waitlist/waitlist-page.test.tsx`,
`src/components/auth-gate/use-auth-gate.test.ts` (run with `bun run test`).

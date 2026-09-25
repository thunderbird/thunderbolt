# Waitlist Module

This module implements a waitlist system that gates access to Thunderbolt. Users must join the waitlist and be approved before they can sign in.

## Endpoints

### POST `/v1/waitlist/join`

The app's email sign-in entry point, not just a signup form. Both the sign-in form (`src/components/sign-in/use-sign-in-form-state.ts`, on first send and on resend) and the waitlist page (`src/waitlist/use-waitlist-state.ts`) post the same body here; the endpoint decides whether the address gets a verification code or a waitlist email.

**Request:**

```json
{ "email": "user@example.com" }
```

**Responses:**

| Status | Body                                                 | When                                                                                                                                        |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `{ "success": true }`                                | The address is on the waitlist but not approved. No verification code is sent.                                                              |
| 200    | `{ "success": true, "challengeToken": "..." }`       | The address is approved — an existing user, an `approved` waitlist row, or an auto-approved domain. Better Auth has sent the sign-in email. |
| 429    | `{ "error": "code_already_sent", "message": "..." }` | A code was requested for the same address inside the cooldown window.                                                                       |
| 422    | Elysia validation error                              | `email` is missing or not a valid address.                                                                                                  |

`challengeToken` binds verification to the request that asked for the code: the client replays it as the `x-challenge-token` header (`challengeTokenHeader` in `backend/src/auth/otp-constants.ts`) on `/sign-in/email-otp`, and the before-hook in `backend/src/auth/auth.ts` rejects the sign-in without a valid one. Non-approved callers never receive a token, so the waitlist gate cannot be walked around with a guessed code alone.

**Behavior:**

- Normalizes the email (lowercase + trim)
- Existing users and `approved` waitlist entries are approved and receive a code
- An address whose domain is in `WAITLIST_AUTO_APPROVE_DOMAINS` is also approved: a new row is created as `approved`, an existing `pending` row is upgraded in place
- Any other existing entry receives a reminder email
- Any other new address is created with `pending` status and receives the joined-waitlist email

**Rate limiting** happens in two independent layers. A 15-second per-email cooldown lives in an in-memory `Map` on the route instance (`cooldownMs`; `0` disables it, which is what the tests do) and returns the 429 above. Its timestamp is written before any async work, so two concurrent requests cannot both pass the check. Separately, `createApp` mounts the shared per-IP `auth` tier — 10 requests per minute, `backend/src/middleware/rate-limit.ts` — on the route; `RATE_LIMIT_ENABLED=false` replaces that layer with a no-op plugin, leaving only the cooldown.

The 429 `message` is English prose that the sign-in form renders verbatim (`getServerErrorMessage` in `use-sign-in-form-state.ts`); unlike the emails below it does not go through the backend catalog.

## Configuration

`WAITLIST_AUTO_APPROVE_DOMAINS` is a comma-separated domain list (empty by default) whose addresses skip the queue. `getWaitlistAutoApproveDomains` (`backend/src/config/settings.ts`) trims and lowercases the entries; `isAutoApprovedDomain` (`utils.tsx`) matches them against the part after the last `@`. `getSettings()` memoizes per process, so a change needs a backend restart.

## Database Schema

| Column      | Type      | Description                            |
| ----------- | --------- | -------------------------------------- |
| `id`        | text      | UUID primary key                       |
| `email`     | text      | Unique, lowercase email                |
| `status`    | enum      | `pending` or `approved`                |
| `batchId`   | text      | Optional, for bulk approval operations |
| `createdAt` | timestamp | Auto-generated                         |
| `updatedAt` | timestamp | Auto-updated                           |

**Indexes:** `email` (via unique constraint), `status`, `batch_id`

## Auth Integration

The waitlist integrates with Better Auth's email OTP flow in `backend/src/auth/auth.ts`:

1. When a user requests an OTP, the system first checks if they're an existing user
2. Existing users bypass the waitlist check (they were approved previously)
3. New users must have an `approved` status on the waitlist to receive an OTP
4. Users on waitlist but not approved receive a "not ready yet" email instead of the OTP
5. Users not yet on the waitlist are inserted with `pending` status and receive the joined-waitlist email instead of the OTP
6. An auto-approved domain short-circuits steps 3-5: a missing row is created as `approved`, a `pending` row is upgraded, and the OTP is sent

`resolveApproval` (`routes.ts`) and the `sendVerificationOTP` callback on Better Auth's `emailOTP` plugin (`backend/src/auth/auth.ts`) reach the same decisions independently — Better Auth's own send-OTP endpoint is reachable directly, so the branch has to exist in both places rather than only on `/join`.

## Email Templates

Three email types are sent by this module via Resend:

| Function                    | When sent                                           |
| --------------------------- | --------------------------------------------------- |
| `sendWaitlistJoinedEmail`   | User joins the waitlist                             |
| `sendWaitlistReminderEmail` | User tries to join again but is already on the list |
| `sendWaitlistNotReadyEmail` | Pending user tries to sign in before being approved |

Approved callers instead get the sign-in email with the code and magic link, sent by `sendSignInEmail` (`backend/src/auth/utils.tsx`).

All four are React components in `backend/src/emails/` passed to Resend's `react` option — there are no hosted templates or template IDs. Each is rendered against the recipient's own locale, resolved from the request's `X-App-Language` header by `resolveEmailLocale`, because most recipients have no `user` row to read a stored locale from.

`shouldSkipEmail` (`backend/src/lib/resend.ts`) short-circuits each send to a console log whenever the Resend client is unconfigured — no `RESEND_API_KEY` — or `NODE_ENV=test`. It does not test for `development` as such, and in production an unconfigured client throws rather than skipping. The usual dev setup therefore never exercises the real send path.

## Security Considerations

- **Uniform status on join**: every well-formed join returns `200`, whether the address is new, pending, approved, or an existing account. The failure modes an enumerator probes for — a 404, an "already registered" error — do not exist here.
- **Approval status is still observable**: `challengeToken` is present only for approved callers, so the response does distinguish an approved address from a queued one. The token is what the verification step consumes, so it cannot be withheld from the callers who need it.
- **Pending users cannot bypass the gate**: the OTP send path and the `/sign-in/email-otp` before-hook both re-check waitlist status, so a challenge token acquired by other means is not on its own enough to sign in.

## Testing

Run tests with:

```bash
cd backend && bun test src/waitlist/routes.test.ts
```

Tests cover:

- Basic join functionality
- Email normalization
- Duplicate handling
- Input validation (422 for invalid emails)
- Challenge token presence for approved callers and absence for pending ones
- Auto-approved domains, including case-insensitive matching and upgrading an existing pending row
- Email send failures surfacing as 500
- Per-locale email rendering from `X-App-Language`

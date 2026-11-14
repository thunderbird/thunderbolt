# Identity and Access

Every non-anonymous user belongs to an organization through a membership, and every way they got in
is recorded as a source on that membership. Access is computed from those sources on every sign-in
and every request. The code is in [`backend/src/identity/`](../../../backend/src/identity), wired into
Better Auth as the `identity()` plugin.

The model holds many organizations; a deployment runs one. `getCurrentOrganizationId()`
([current-organization.ts](../../../backend/src/identity/current-organization.ts)) returns the implicit
org `default`, every identity query takes its org from there, and the same id is the SCIM
`provisioningDomainId`.

## Tables

All server-only, none synced through PowerSync ([identity-schema.ts](../../../backend/src/db/identity-schema.ts)).
Each has `org_id`, and uniqueness is scoped to it.

| Table                                                     | Holds                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`                                            | The org                                                                                                                                      |
| `org_membership`                                          | One row per (org, user), plus a local block                                                                                                  |
| `membership_source`                                       | One row per way in: `scim`, `sso`, `invitation`, `domain`, `waitlist`, `open`, `local`, `bootstrap`; each `active`, `suspended` or `removed` |
| `member_role_grant`                                       | Local role grants, the bootstrap admin's included                                                                                            |
| `identity_connection`                                     | One IdP integration: an SSO side, a SCIM side, or both, its match claim and its status                                                       |
| `invitation`, `org_domain`, `link_review`                 | Native admission and the linking review queue                                                                                                |
| `local_group`, `local_group_member`, `group_role_mapping` | Local groups, and group-to-role mappings keyed on a local group or a SCIM group's id, never a name                                           |
| `audit_event`                                             | The append-only audit log                                                                                                                    |

The SCIM plugin's own tables are in [scim-schema.ts](../../../backend/src/db/scim-schema.ts). The
identity tables are also declared to Better Auth ([plugin-schema.ts](../../../backend/src/identity/plugin-schema.ts))
so hooks can use them through the auth adapter. Better Auth checks on every `auth.api` call that the
Drizzle schema has every column its models write, and fails the call if not.

## The access check

`computeAccess` ([access.ts](../../../backend/src/identity/access.ts)) decides, in this order:

1. no membership: refused (`ACCESS_NOT_MEMBER`)
2. a local block: refused (`ACCESS_BLOCKED`), whatever any IdP says
3. while any SCIM source manages the member, access follows those sources alone: at least one must be
   active (`ACCESS_DEPROVISIONED` otherwise). Invitations, domains and other local grants don't count.
4. otherwise any active source admits (`ACCESS_NO_LIVE_SOURCE` otherwise)

A SCIM source on a connection whose SCIM side is retiring or retired is ignored: it neither keeps the
member in nor deprovisions them. An `sso` source (a connection without SCIM) counts like a local grant,
because nothing can deprovision it automatically.

Where it runs:

| Surface                                                          | How                                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every sign-in that creates a session                             | `session.create.before`: admission (below), then the check. A refusal is a 403 with the code above, and writes a failed `auth.sign_in` audit event after the sign-in rolls back. |
| Every `auth.api.getSession` (route macro, WebSockets, PowerSync) | An after-hook on `/get-session` returns no session, so the member reads as signed out (401).                                                                                     |
| API keys                                                         | The api-key plugin answers `/get-session` before after-hooks run, so its `customAPIKeyValidator` runs the check (`apiKeyOwnerHasAccess`).                                        |
| PowerSync bearer refresh, CLI device registration                | These read the session row themselves, so they call `hasAccess` and answer 401.                                                                                                  |
| Passkey management                                               | The guard in `auth.ts` answers 401 when the filtered session lookup finds nothing.                                                                                               |

Better Auth's other session routes (`/api-key/create`, `/list-sessions`) authenticate cookie and
bearer callers with their own internal lookup, which skips the after-hook. Nothing they produce works
for a refused member: a key created that way is refused at use.

Anonymous users are not members. Every step above skips them, so anonymous sign-in, where enabled,
bypasses the organization entirely.

## Admission at sign-in

`admitAtSignIn` ([admission.ts](../../../backend/src/identity/admission.ts)) runs in the sign-in's
transaction. A user with no membership is admitted by the first rule that matches:

- `invitation`: an email-code sign-in whose address holds a usable invitation, which it consumes
- `domain`: an email-code sign-in on a verified org domain open to enrollment
- `waitlist`: an email-code sign-in whose address has an approved waitlist row, unless an IdP claims its domain
- `open`: with `OPEN_SIGNUP_ENABLED`, any email-code sign-in, unless an IdP claims its domain
- `sso`: a sign-in through a connection without SCIM (see below)

These rules run only for a user with no membership, so none of them can bring a member back: a blocked
or IdP-deprovisioned member never reaches them, and `computeAccess` ignores local sources while a
SCIM source manages a member anyway.

Admission waits for the session rather than user creation because Better Auth runs
`user.create.after` only after the transaction commits, too late for the SSO callback's session.

A new email address gets a sign-in code without an approved waitlist row only when
`admitsWithoutWaitlist` says so: a bootstrap admin email, a usable invitation, an enrollable domain, or
open sign-up. All three places that gate codes ask it, so a new way in is added once.

A claimed-domain address with an approved waitlist row still gets a code, because the waitlist gates
in `auth.ts` don't know about claims. Its sign-in creates the user row and is then refused with
`ACCESS_NOT_MEMBER`, which leaves a user with no membership. That is harmless: a later overridden
invitation still admits them, since the rules run for anyone without a membership.

### Invitations

An invitation ([invitations/invitations.ts](../../../backend/src/identity/invitations/invitations.ts))
names one address in one org, expires after a week, and is used once. `createInvitation` emails a
link to `/invite/<token>`; only the token's SHA-256 is stored. The link opens the invite-accept
screen, which looks the invitation up with `GET /v1/invitations/:token` (404 for anything no longer
usable) and offers the email code for the invited address. Admission matches the verified address,
not the token: the email-code sign-in for that address consumes the invitation with a status-guarded
update, so a second sign-in, or one racing it, finds nothing to consume.

- An address on a domain an IdP claims is refused (`DOMAIN_CLAIMED_BY_IDP`, audited as a denied
  `invitation.created`) unless the admin sets `idpOverride`, which is recorded on the row and audited as
  `invitation.override_used`. The claim is checked again at sign-in, so a domain claimed after a plain
  invitation was sent closes it.
- An existing member can't be invited (`ALREADY_MEMBER`). Inviting an address again revokes its
  pending invitation.
- The email goes out from the inviting admin's request, so its language is the admin's, passed in as
  `locale`.

### Approved domains

An org domain ([domains.ts](../../../backend/src/identity/domains.ts)) is verified by a TXT record at
`_thunderbolt-verification.<domain>` holding `thunderbolt-verification=<token>`, looked up with the
system resolver. Matching is exact: a subdomain never matches its parent. Once verified, a domain
stays verified; nothing re-checks it. Only a verified domain that no IdP connection claims can be
opened to enrollment, and members who join by domain get no role grant, only the implicit `member`
role, whatever `enrollment_role` says. Claims match the exact domain too: a claim on `corp.com` does
not close `eu.corp.com`, so each subdomain must be claimed on its own.

`WAITLIST_AUTO_APPROVE_DOMAINS` is separate: a waitlist-only bypass that never creates an org domain.

An existing member who signs in through a connection without SCIM, and has no `sso` source for it,
gets one (`member.source_added`) before the access check. Without it, the members a connection's
SCIM side provisioned would be locked out of its SSO side once that SCIM side starts retiring. A block, or
another IdP deprovisioning them, still wins, because the check runs after.

### Existing users

At boot, after migrations, `ensureImplicitOrganization` ([organization.ts](../../../backend/src/identity/organization.ts))
creates the org and, in the same transaction, gives every non-anonymous user an active membership.
The source records how they most likely got in: `sso`, `waitlist`, or `open` for accounts older than
the waitlist. The backfill runs only on the call that creates the org; repeating it on every boot would
admit users that some path forgot to admit.

## SSO connections

An SSO connection is a Better Auth `sso_provider` row named by an `identity_connection`'s
`sso_provider_id`; the same row's `scim_connection_id` pairs it with a SCIM connection. One row per
IdP holds both sides, and only server-side admin code creates them
([sso-connections.ts](../../../backend/src/identity/sso-connections.ts)). A request naming a provider
with no live connection is refused ([sso.ts](../../../backend/src/identity/sso.ts)), so rows older
releases let users register can't sign anyone in.

- **The env provider** (`OIDC_*` or `SAML_*`) is written at boot as provider and connection `sso`, after
  the implicit org. The env stays authoritative for that row; connections an admin created are never
  touched. The first run fills that connection into the `sso` sources of members who signed in before.
- **Require a SCIM record before first login** is on only while the connection's SCIM side is
  `active` (`requiresScimRecord`). From `scim_retiring` on, the access check ignores that side's
  sources, so the connection admits at sign-in like one without SCIM. Then the `sso` rule admits nobody, so an unprovisioned
  subject is refused with `ACCESS_NOT_MEMBER` and, since the SSO callback runs user creation and
  admission in one transaction, no user is created. A `BOOTSTRAP_ADMIN_EMAILS` address is the one
  exception: the bootstrap grant admits it before SCIM provisions it.
- **Email linking** happens only on a connection without SCIM, and never to a user a SCIM connection
  manages, on any connection.
- **The match claim** (`match_claim`: `oid` for Entra, `sub` for Okta and Keycloak) is stored per
  connection for the SCIM lifecycle to match a sign-in to its SCIM record.
- **The login screen** asks `POST /v1/sso/discover` which connections to offer: the only one, else the
  one whose `org_domain` claims the email's domain, else all of them, one button each. It answers from
  the domain alone, so it never reveals whether an address is a member.
- **Email code in SSO mode** lives at `/sign-in/email-code`, for people no IdP manages (an invitee, a
  break-glass admin); the email-code gates decide who may use it. It is linked from the email step,
  the connection list and `/sso-error`. With one connection the app goes straight to the IdP, so a
  break-glass admin must know the URL in advance: an IdP that is down never redirects back to
  `/sso-error`.

## Roles

`getMemberAuthorization` ([roles.ts](../../../backend/src/identity/roles.ts)) returns the union of local
grants, the roles mapped to the member's local groups, and the roles the SCIM plugin projected from
their IdP groups, plus `member`. Roles are usable only with access: a refused member has none, even
with a stored grant. Access and roles are separate, so a local grant stays until an admin removes it.

## Bootstrap admin

A `BOOTSTRAP_ADMIN_EMAILS` address gets the admin role at its first verified sign-in, by email code or
SSO ([bootstrap-admin.ts](../../../backend/src/identity/bootstrap-admin.ts)), and skips the waitlist.
An OIDC sign-in whose provider says `email_verified: false` is not a verified sign-in: the SSO
`resolveUser` hook records the denial for the request, and the grant is skipped.
The `bootstrap` membership source is the once-per-email marker. It goes away with the user on a
permanent delete, so a still-listed email gets admin again at its next sign-in.

## Audit

The action list is in [audit/events.ts](../../../backend/src/identity/audit/events.ts); the outcome
(`success`, `failure`, `denied`) is a separate column. Events never hold secrets, only ids.

- `insertAuditEvent(tx, event)` writes with the Drizzle transaction that makes the change;
  `createAuditEvent(adapter, event)` does the same through Better Auth's adapter inside hooks.
- A failed attempt's transaction rolls back, taking any event in it along. `recordFailedAttempt` writes
  the failure after that transaction ends.
- `GET /v1/admin/audit-events` pages admins through the log, newest first, at most 100 a page.
  Viewing a page is not audited. Every admin route goes through `createAdminMacro`, which re-checks the
  admin role on each request and records a denied attempt as `admin.access_denied`.

## SCIM

The IdPs provision into `/v1/api/auth/scim/v2`, served by `@better-auth/scim` behind our own
request pipeline ([identity/scim/](../../../backend/src/identity/scim)). The URL sits under Better
Auth's mount because the plugin builds `meta.location` from it. It is exempt from the app-version gate.

### Connections

A SCIM connection is the SCIM side of an `identity_connection` row, one row per IdP with its SSO
side beside it. `scim_connection_id` names the plugin's managed connection, and only
[connections.ts](../../../backend/src/identity/scim/connections.ts) writes it. The functions there are
server-only, for the admin routes to wrap, and each writes its audit event in the same transaction:

| Function               | Does                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `createScimConnection` | a new SCIM-only row, or the SCIM side of an existing one. Only an `active` row with no SCIM side can take one |
| `rotateScimCredential` | another credential; the old one works until revoked or expired, so the IdP switches over without a gap        |
| `revokeScimCredential` | stops one credential at once                                                                                  |
| `getScimConnection`    | the row and its credentials (status, `expiresAt`, last use)                                                   |
| `retireScimConnection` | revokes its credentials and moves `active` → `scim_retiring` at once, then `scim_retired` in the background   |

- Create and rotate return the token. It is shown only then, and never stored or audited: the
  plugin keeps an HMAC digest.
- Credentials expire after 365 days by default; the plugin requires an expiry.
- The digest key is derived from `BETTER_AUTH_SECRET` with HKDF, so **rotating `BETTER_AUTH_SECRET`
  invalidates every SCIM token**: issue new ones and update each IdP.
- A row whose SCIM side is retiring or retired never gets a new one. That would make the access
  check count the retired connection's sources again.

Retiring: one transaction revokes the connection's credentials and moves the row to
`scim_retiring`, so from that commit on its tokens are refused and the access check ignores its
sources. A background job then runs the plugin's decommission, which walks every SCIM user in the org
in leased batches. When it completes the row is `scim_retired`,
and its `scim_connection_id` stays, because the membership sources still name it. The plugin's lease
makes runs on several workers safe, and a run a restart interrupted resumes at boot and on the
hourly sweep.

### The request pipeline

[request.ts](../../../backend/src/identity/scim/request.ts) handles every SCIM request before the
plugin sees it:

1. **Rate limits.** A per-credential budget, plus a per-IP budget spent only by 401s. SCIM skips the
   `auth` tier and Better Auth's limiter. See [rate-limiting.md](../../../backend/docs/rate-limiting.md#scim).
2. **One write at a time per user or group** within the process. On Postgres, a user PATCH also
   holds an advisory lock every backend instance shares, because it writes an `emails` list built
   from its own read (step 3), which a write on another instance in between would undo.
3. **Provider requests normalized** ([normalize.ts](../../../backend/src/identity/scim/normalize.ts)):
   - Unknown extension schemas (Entra directory extensions) are dropped from bodies and PATCHes, rather
     than answered with 400.
   - `emails[value eq "…"].value`, the Keycloak extension's only form of email change, becomes a
     replace of the whole `emails` list.
   - `externalId` is required on create, and can't change once set. A PUT that leaves it out keeps the
     stored value. It is the IdP's stable id; without it a user can't be linked to SSO or
     reprovisioned after `DELETE`, and changing it hands the account to whoever the new id names.
4. **Retry on "changed concurrently".** On Postgres, parallel writes to one user or group lose the
   plugin's optimistic-lock check with a 409. The plugin's transaction rolled back, so the pipeline
   sends the request again, up to 5 times with jittered backoff. This covers what the in-process lock
   can't: other workers, and a group change racing a user change.

PATCH and PUT on a user first read the stored user through the plugin with the caller's own token,
so the checks in step 3 see the connection's own data and nothing else.

Users the IdP provisions have `emailVerified` set: the IdP vouches for the address.

Not supported yet: groups with duplicate names (Entra allows them) and users without an email.
The plugin refuses both.

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
because nothing can deprovision it automatically, until its connection is retired: then it is ignored
the same way, so members that connection alone let in lose access.

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

### SSO only for IdP-managed members

A member is **IdP-managed** (`isIdpManaged`) while they have a SCIM source on a connection whose SCIM
side is active, in any status: a `removed` source counts until an admin detaches the link. When one of
those connections also has an SSO side (`requiresSso`), the sign-in check refuses email code and
passkey sign-in with `ACCESS_SSO_REQUIRED`, so the IdP's MFA and conditional access always apply. The
code is still sent: refusing at send time would tell anyone who typed the address that an IdP manages
it. A passkey still unlocks E2EE keys after an SSO sign-in, which never reaches the server. Members of
a connection with only a SCIM side keep email code and passkeys, as they have no SSO to use.

IdP-managed members can't delete their own account (`DELETE /v1/account` and its step-up code answer
403 `ACCOUNT_IDP_MANAGED`): the account goes when the IdP removes it, and a self-delete would drop the
SCIM tombstone the IdP reprovisions through.

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
IdP holds both sides, and only server-side admin code creates and edits them
([sso-connections.ts](../../../backend/src/identity/sso-connections.ts)). A request naming a provider
with no live connection is refused ([sso.ts](../../../backend/src/identity/sso.ts)), so rows older
releases let users register can't sign anyone in.

- **Retiring** a connection (`retireSsoConnection`) sets it `retired`: its SSO side signs nobody in,
  and its members' `sso` sources stop counting. That offboards members it alone admitted; anyone with
  another live source keeps access. The env connection can't be retired here (its settings own it),
  nor can a row whose SCIM side isn't `scim_retired` yet: retire that side first.
- **Editing** a connection (`updateSsoConnection`) changes its name, match claim, OIDC client and
  discovery URL, or SAML certificate and entry point, merging them into the stored config. What
  names the IdP or our service provider (provider id, OIDC issuer, SAML entity ids) is refused with
  `SSO_IDENTITY_FIELD_IMMUTABLE`. What decides which IdP identity an `account` belongs to (client id,
  discovery URL, entry point) changes only while the provider has no `account`, else
  `SSO_IDENTITY_FIELD_LOCKED`; the match claim also needs no pending or approved link review, as it
  keys them (`SSO_MATCH_CLAIM_LOCKED`). A secret or certificate rotation therefore never relinks
  anyone. A new discovery URL passes the trusted-origin check sign-in applies. `connection.updated`
  names the changed fields, never a value. The env connection is refused with `SSO_CONNECTION_ENV_OWNED`.
- **The env provider** (`OIDC_*` or `SAML_*`) is written at boot as provider and connection `sso`, after
  the implicit org. The env stays authoritative for that row; connections an admin created are never
  touched. The first run fills that connection into the `sso` sources of members who signed in before.
- **Require a SCIM record before first login** is on only while the connection's SCIM side is
  `active` (`requiresScimRecord`). From `scim_retiring` on, the access check ignores that side's
  sources, so the connection admits at sign-in like one without SCIM. Then the `sso` rule admits nobody, so an unprovisioned
  subject is refused with `ACCESS_NOT_MEMBER` and, since the SSO callback runs user creation and
  admission in one transaction, no user is created. A `BOOTSTRAP_ADMIN_EMAILS` address is the one
  exception: the bootstrap grant admits it before SCIM provisions it.
- **Email linking** happens only on a connection without SCIM, never to a user a SCIM connection
  manages, and never to a user who already signs in through another SSO connection: those go
  through the linking tiers (below).
- **The match claim** (`match_claim`: `oid` for Entra, `sub` for Okta and Keycloak, or a SAML attribute)
  names the claim whose value is the subject's SCIM `externalId`. On a connection whose SCIM side is
  active, the SSO `resolveUser` hook signs the subject into the user of that SCIM record
  (`acquireActiveSCIMUserLink`), never by email. A deactivated or deleted record refuses the sign-in
  with `ACCESS_DEPROVISIONED`; a sign-in without the claim is refused with `SSO_MATCH_CLAIM_MISSING`.
  Entra's `sub` is pairwise per app, so Entra connections match on `oid`.
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

A SCIM group grants the roles `group_role_mapping` maps to its id, never its name
([projection.ts](../../../backend/src/identity/scim/projection.ts)), so renaming a group to "Admins"
grants nothing. The plugin stores the result in `scimProjectionGrant` and keeps it in step with group
membership; a deactivated or deleted SCIM user holds none. `createScimGroupRoleMapping` and
`deleteScimGroupRoleMapping` ([role-mappings.ts](../../../backend/src/identity/scim/role-mappings.ts))
change a mapping with its audit event, then replay the projection for the whole org
(`reconcileSCIMProjection`), so members' roles change at once rather than at the IdP's next change.

## Permanent purge

`purgeMember` ([purge.ts](../../../backend/src/identity/purge.ts)), for the admin routes, hard-deletes a
member who has lost access: the user row cascades to their data, devices, `org_envelopes` and SCIM
records, the tombstone included. It is allowed for a member an IdP removed with `DELETE`, one an admin
blocked, or a local member with no live source. It is refused while the member has access, while an
IdP has only suspended them (`active:false` can be reversed), and for the admin themselves. The
`member.purged` event has no foreign key, so it outlives the user.

## Bootstrap admin

A `BOOTSTRAP_ADMIN_EMAILS` address gets the admin role at its first verified sign-in, by email code or
SSO ([bootstrap-admin.ts](../../../backend/src/identity/bootstrap-admin.ts)), and skips the waitlist.
An OIDC sign-in whose provider says `email_verified: false` is not a verified sign-in: the SSO
`resolveUser` hook records the denial for the request, and the grant is skipped.
The `bootstrap` membership source is the once-per-email marker. It goes away with the user on a
permanent delete, so a still-listed email gets admin again at its next sign-in.

## Admin API

The routes the admin screens call live under `/v1/admin` ([identity/admin/](../../../backend/src/identity/admin)).
They wrap the services above and add only what had no service: member admin, local groups and their
role mappings, domain claims, and the break-glass flag.

- **The admin check.** Every route takes `{ admin: true }` (`createAdminMacro`). A signed-in
  non-admin gets 403 `ADMIN_REQUIRED` and an `admin.access_denied` event; a caller without access,
  a blocked admin included, reads as signed out and gets 401. Elysia validates a request before the
  macro runs, so a malformed body from a non-admin gets 422 and records nothing: it learns only the
  schema.
- **Errors.** Services throw `APIError` or `AdmissionError` with a code, and the routes answer
  `{ code, message? }` with the service's status ([errors.ts](../../../backend/src/identity/admin/errors.ts)).
  A policy refusal (a 403 or 409, or an admin purging themselves) is recorded as a `denied` event of
  the action it attempted, unless its service records it itself. Input conflicts such as a taken
  name are not.
- **What an IdP manages.** A member `isIdpManaged` has their email, name, SCIM groups, SCIM-mapped
  roles and SCIM status owned by the IdP; the member view lists them under `idpManaged.fields`.
  Renaming such a member is refused with `FIELD_MANAGED_BY_IDP`, and revoking a role held only
  through a SCIM group with `ROLE_MANAGED_BY_IDP`. No admin can change anyone's email: the address
  is how a member signs in. Local grants and the local block stay editable on every member.
- **Blocking** sets `org_membership.blocked_at`, which the access check reads first. The member's
  sessions are deleted (one `auth.session_revoked` each, the admin as actor, the member as target,
  `metadata.reason: 'member_blocked'`); devices and API keys stay, refused while
  blocked, so unblocking needs only a new sign-in. A PowerSync token already issued lasts at most
  `powersyncTokenExpirySeconds` (300 s). An admin can't block themselves.
- **Roles.** Only roles the system knows can be granted or mapped (`assignableRoles`: `admin`).
- **No last-admin refusal.** A change that leaves no admin able to sign in without the IdP succeeds,
  and its response carries `warning: 'NO_LOCAL_ADMIN'`. An admin managed only through a SCIM-only
  connection still counts: email-code sign-in stays open to anyone no IdP requires SSO of. `GET /v1/admin/break-glass` reports the same
  state as `allAdminsIdpManaged`, with the admin counts. Only shared hosting would have to refuse it.
- **Hard deletes.** Local groups, their members, local role mappings, local role grants (a revoke,
  the bootstrap admin's grant included), org domains and a detached link's rows have no `deleted_at`;
  deleting one removes it, and its audit event keeps the history. A group's delete records one
  `group_role_mapping.deleted` for each mapping it takes with it, and its member count.
- **Domain claims.** `claimOrgDomain` needs a verified domain and a live connection, and refuses a
  domain another connection holds, a concurrent claim included; unclaim it first. Claiming turns
  enrollment off, so unclaiming leaves the domain closed until an admin opens it. A claimed domain
  can't be removed.
- **Detaching an IdP link.** `POST /v1/admin/members/:userId/connections/:connectionId/detach`
  (`detachMemberLink`) deletes the member's `scim` and `sso` sources on that connection, their
  `account` on its SSO side and the plugin's tombstone for them on its SCIM side, in one transaction
  with its `link.detached` event, so their other sources and local grants decide their access again.
  Only a `scim` source the IdP deleted (`removed`), or one the access check ignores, can be detached:
  an `active` one is refused with `LINK_SOURCE_ACTIVE`, a `suspended` one with
  `LINK_SOURCE_SUSPENDED` (the plugin keeps that record, and a reactivation would bring the source
  back), a link with no `scim` source with `LINK_NOT_DETACHABLE`, and an admin's own link with
  `DETACH_SELF`. With the tombstone gone, the IdP creating the same identity again goes through the
  linking tiers rather than back to the user. The detach reads the member's sources on that
  connection `for update`, so a SCIM write that would reactivate one waits for it to commit, and one
  that committed first makes it refuse. The plugin reads the tombstone before its own transaction,
  so a create that read it just before the detach commits still links back to the member, who is
  then IdP-managed again through a live source.
- **Link reviews.** `GET /v1/admin/link-reviews` pages the review queue; `POST …/:reviewId/approve`
  and `…/reject` wrap `approveLinkReview` and `rejectLinkReview`, which audit what they resolve. Their
  refusals (`LINK_REVIEW_SELF`, `LINK_REVIEW_RESOLVED`, `LINK_REVIEW_RECORD_EXISTS`) are recorded as
  denied attempts.
- **Lists** page by an opaque `cursor`, at most 100 rows a page (`limit`, default 50). Domains,
  connections and role mappings are per-org configuration and come back whole.

## Audit

The action list is in [audit/events.ts](../../../backend/src/identity/audit/events.ts); the outcome
(`success`, `failure`, `denied`) is a separate column. Events never hold secrets, only ids: a session
id, never its token; an API key's or SCIM credential's id, never its value; no email code, invitation
token, IdP assertion or IdP error description. `no-secrets.test.ts` runs each such flow with the
secret known and checks no row holds it.

- `insertAuditEvent(tx, event)` writes with the Drizzle transaction that makes the change;
  `createAuditEvent(adapter, event)` does the same through Better Auth's adapter inside hooks.
- A failed attempt's transaction rolls back, taking any event in it along. `recordFailedAttempt` writes
  the failure after that transaction ends.
- Every request runs under a server-generated id (`request-context.ts`), and each event it writes
  carries it as `request_id`, so the several events one request causes correlate. The context also
  holds the API key `resolveAuthSession` authenticated the request with, if any (see Actors).
- `GET /v1/admin/audit-events` pages admins through the log, newest first, at most 100 a page.
  Each event carries `actorLabel` and `targetLabel`, the actor's and target's names looked up in the
  org at read time ([labels.ts](../../../backend/src/identity/audit/labels.ts)), and `apiKeyLabel`,
  the name of the API key the actor acted through; a person is named only while they're a member,
  and a deleted target or key reads as null. The `q` search matches the key's name too.
  `GET /v1/admin/audit-events/:eventId` returns one event in the same shape, labels included, and
  answers `404 AUDIT_EVENT_NOT_FOUND` for an id that isn't in the caller's org.
  Viewing a page or an event is not audited. Every admin route goes through `createAdminMacro`, which re-checks the
  admin role on each request and records a denied attempt as `admin.access_denied`.

### Actors

The actor is the `user` who acted, a `scim_connection` for anything a SCIM request causes, or the
`system`. A request made with an API key acts as the key's owner: the owner is the actor, and each
event whose actor they are carries `metadata.apiKeyId`. Only routes that resolve their session
through `resolveAuthSession` (the admin API, client reports) record the key; Better Auth's own
routes called with a key, such as `/revoke-sessions`, record the owner without it. A SCIM event
names the identity connection and the credential the IdP authenticated with, never an upstream
person: the IdP doesn't say who, so nothing is invented.

### Sign-in

Every sign-in writes `auth.sign_in` with its `metadata.method` (`email_code`, `passkey`, `oidc`,
`saml`, `device_grant`) and, for SSO, the connection. Sign-in events are the only ones that store the
client's IP address and user agent ([sign-in-audit.ts](../../../backend/src/identity/sign-in-audit.ts)).

- **Success** is recorded when a session was created, with its id, so an SSO callback, which answers
  success with a redirect too, records only real sign-ins. It is written just before the session, so
  no session exists without it; an SSO sign-in writes both in one transaction.
- **Failure** is recorded with the error code: Better Auth's (`INVALID_OTP`), the access refusal
  (`ACCESS_BLOCKED`), or, on SSO, the `error` the callback redirects with (`account_not_linked`). The
  device grant's `authorization_pending` and `slow_down` are polling, not failures.
- A refusal thrown by a before-hook skips every after-hook, so the `auth.ts` before-hook records its
  own through `refuseSignIn`: a missing or invalid challenge token, a new address with no approval, a
  foreign SSO provider, and a SAML response this browser didn't start.
- The actor of a failure is the user the attempt named, when one exists: the address's owner, or the
  passkey's. An attempt on an unknown address stores nothing that identifies it.

### Sessions

A `session.delete.before` hook in the identity plugin sees every session Better Auth deletes, in the
deleting transaction, and tells them apart. Expiry is checked first, on any route: a revocation
route that finds its own caller expired records an expiry, not a revocation ([session-audit.ts](../../../backend/src/identity/session-audit.ts)):

| Deleted by                                                               | Action                 | Actor                                        |
| ------------------------------------------------------------------------ | ---------------------- | -------------------------------------------- |
| `/sign-out`                                                              | `auth.sign_out`        | the user                                     |
| `/revoke-session(s)`, `/revoke-other-sessions`                           | `auth.session_revoked` | the user                                     |
| any route that finds a session past its expiry (usually `/get-session`)  | `auth.session_expired` | `system`                                     |
| a SCIM request that leaves the member no active source (`active: false`) | `auth.session_revoked` | the SCIM connection, with the credential     |
| the SCIM connection retirement walk, or the projection replay            | `auth.session_revoked` | `system`, the operation in `metadata.reason` |

Anything else writes its own event. A SCIM `DELETE` deletes its sessions through the raw adapter,
so the SCIM lifecycle records one `auth.session_revoked` per session itself. Device revocation and
CLI logout delete sessions with Drizzle, so [account.ts](../../../backend/src/api/account.ts)
records them as `auth.session_revoked` and `auth.sign_out` on the device. An admin revoking a member's sessions is `auth.session_revoked` with
the admin as actor and the member as target. Closing a tab or the app is not observable, and neither
is a session that expires unread.

**IdP-initiated logout is not supported.** `@better-auth/sso` has no OIDC back-channel logout endpoint,
and its SAML single logout (`saml.enableSingleLogout`) is off: turning it on changes the SP metadata
and needs each IdP configured for it. An IdP ends a member's sessions through SCIM
deprovisioning instead.

### Connections

A user's own connections change on the device: MCP servers and every credential stay local, and the
synced `provider_connections` rows can't tell a user's change from a migration or a retry. So the app
reports them itself, through `POST /v1/audit/client-events`
([client-routes.ts](../../../backend/src/identity/audit/client-routes.ts)), as `user_connection.added`,
`updated`, `removed` and `credential_replaced`. These rows have `report_source = 'client'`, which the
audit screen labels client-reported: the device's word, not something the server saw.

- The body holds only an action, a target type and id, a provider and an auth method, all id-shaped;
  the server sets the actor, the bound device and the time.
- Reports are best effort ([report-connection-event.ts](../../../src/lib/report-connection-event.ts)):
  one that fails is dropped with a warning, never queued.
- An OAuth authorization (a provider, an MCP server) reports once, when it completes; a token refresh
  never reports.
- Anonymous users' reports are dropped.

### Flooding

A caller who can trigger an event at will must not grow the log at will. `admin.access_denied` is
capped at 10 per user an hour and never recorded for anonymous callers, whose every sign-in is a new
user; client reports are capped at 60 per user an hour. Both caps ignore `RATE_LIMIT_ENABLED`
([rate-limiting.md](../../../backend/docs/rate-limiting.md#audit-budgets)). Failed sign-ins are bounded
by the `auth` IP tier instead, which a distributed attempt can spread across addresses.

### Retention

Audit events are kept indefinitely for now: nothing purges them. `audit_event` has no foreign key to
`user`, so an event outlives the account it names. After an account is deleted, by the user or by an
admin purge, its events keep `actor_id`, `target_id`, `ip_address` and `user_agent`. Removing them
takes direct database access outside the app, which is not itself audited.

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
   A request the pipeline refuses before the plugin authenticates it is answered with the 401 when
   the caller isn't authenticated, so made-up tokens spend the per-IP budget like any other.
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

Each request the backend rejects, once it knows the connection, writes a failed `scim.request` audit
event with that connection and credential, the method, the resource and the plugin's error
([failures.ts](../../../backend/src/identity/scim/failures.ts)), never the body. A refusal the
pipeline makes itself first asks the plugin who the token belongs to. A 401 can't be attributed, and
rate-limit refusals and conflicts a retry fixed are not recorded. A credential leaves at most 60 of
these an hour (`scim-failure-record`); past that they go unrecorded. An admin reads them with
`GET /v1/admin/audit-events?connectionId=…&action=scim.request&outcome=failure`.

### Lifecycle

The plugin's `identity` callbacks ([lifecycle.ts](../../../backend/src/identity/scim/lifecycle.ts)) run
inside every SCIM user transaction. The plugin passes the user's resulting SCIM users, not the
operation, so the change is read off the member's `scim` sources, one per connection, whose `ref` is the
plugin's SCIM user id:

| SCIM                   | Membership source                    | Devices, sessions, API keys                                                                                 |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| create                 | added (the membership too, if none)  | untouched                                                                                                   |
| `active:false`         | `suspended`                          | kept; the plugin signs them out, and API keys, sync and WebSockets are refused                              |
| `active:true`          | `active`                             | the same devices sync again after sign-in                                                                   |
| `DELETE`               | `removed`; the user and data stay    | if that ends their access: devices revoked, sessions and API keys deleted; envelopes right after the commit |
| re-POST after `DELETE` | `active` again, with the new SCIM id | the same user, with no trusted device: their recovery phrase or passkey restores it                         |

The revocation commits with the membership change. Envelopes have no `id` column, so Better Auth's
adapter can't reach them inside the plugin's transaction; they are deleted with `deleteEnvelope` as
soon as it commits, and a failure is logged with the user id without failing the request. Until then
every envelope route already refuses the revoked device.

Another IdP that still vouches for the member keeps their devices through one IdP's `DELETE`. A source
on a connection whose SCIM side is retiring or retired is left alone, so the decommission walk changes
nothing.

Every SCIM resource change writes its audit event (`scim.user_*`, `scim.group_*`) in the same
transaction, attributed to the connection, from the plugin's identity and projection callbacks, and
only when something changed, so a replay writes nothing. `getScimActor()`
([actor.ts](../../../backend/src/identity/scim/actor.ts)) gives the request's
`{ identityConnectionId, scimConnectionId, credentialId }`; the audit `connectionId` is always the
`identity_connection` id. A change to a group with no members reaches no callback, so the pipeline
records it after the commit; a memberless group grants nothing. Sessions the revocation deletes write
one `auth.session_revoked` each; the ones the plugin signs out go through Better Auth's session hooks. Revocation is not a remote wipe: a revoked device clears
its data only when it next reaches the server. `identity.resolveUser` links an incoming identity only through the linking tiers (below).

Not supported yet: groups with duplicate names (Entra allows them) and users without an email.
The plugin refuses both.

## Linking

An incoming IdP identity whose email an existing user owns is joined to that user only through one
of two tiers ([linking.ts](../../../backend/src/identity/linking.ts)), never by email alone. Two
existing users are never merged: each has its own E2EE account key, and a link only attaches an
`account` (SSO) or a SCIM user to one user. Nothing touches their devices or envelopes, so the first
sign-in on a new device still goes through device approval.

1. **Domain:** the email's exact domain is verified and claimed by the connection the identity
   arrives on. A user who has, or had, a SCIM record on that same connection is excluded: the IdP
   sending a new `externalId` for their email (Keycloak recreating a user with a new UUID) means a
   different identity.
2. **Review:** everything else waits for one admin in `link_review`
   ([link-reviews.ts](../../../backend/src/identity/link-reviews.ts)). An approval doesn't link by
   itself: the IdP's next attempt does.

Every link to an existing user writes `link.created`, with `tier` naming how it was made: a tier
above, `scim_record` for the first SSO sign-in that reaches a user through their SCIM record, or
`email` for the email rules of a connection without SCIM. Where each path applies:

- **SCIM create** (`identity.resolveUser`, before the plugin's transaction): an approved review for
  the connection and `externalId` links to its user; otherwise tier 1; otherwise the review is opened
  (or its `attempts` and `lastSeenAt` bumped) and the create gets the plugin's 409 `uniqueness`.
  Nothing reaches the existing user until an admin approves and the IdP retries.
- **SSO on a connection with SCIM:** only the SCIM record. An approved review attaches through the
  SCIM retry.
- **SSO on a connection without SCIM:** an approved review keyed on the match claim, then the email
  rules above. A user who already signs in through another SSO provider goes through tier 1,
  else the sign-in is refused with `LINK_REVIEW_PENDING` and the review is written once the sign-in
  has rolled back.

**Profile.** Only one SCIM source manages a user's email and name. The first IdP to link a local user
takes it over (`manage`); a user another SCIM source already manages is linked with `preserve`, so
with Entra and Keycloak both provisioning one person, the first keeps managing the profile.

**The queue** (`listLinkReviews`, `approveLinkReview`, `rejectLinkReview`, for the admin routes):

- One open review per connection and `externalId`; retries only bump it.
- A rejection is final for the IdP: its retries keep getting 409 and bump the rejected review. An
  admin can still approve it later.
- An admin can't approve their own link (`LINK_REVIEW_SELF`): a sole admin links their own identity
  by claiming the domain for that connection; otherwise a second admin approves it. Approval is also refused while the
  candidate still has a SCIM user on that connection (`LINK_REVIEW_RECORD_EXISTS`), because the
  plugin allows one per connection and user: the IdP must delete the old record first.

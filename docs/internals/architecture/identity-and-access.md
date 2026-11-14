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

- `waitlist`: an email-code sign-in whose address has an approved waitlist row
- `sso`: a sign-in through the SSO callback or SAML ACS

Admission waits for the session rather than user creation because Better Auth runs
`user.create.after` only after the transaction commits, too late for the SSO callback's session.

A new email address gets a sign-in code without an approved waitlist row only when
`admitsWithoutWaitlist` says so. All three places that gate codes ask it, so a new way in is added once.

### Existing users

At boot, after migrations, `ensureImplicitOrganization` ([organization.ts](../../../backend/src/identity/organization.ts))
creates the org and, in the same transaction, gives every non-anonymous user an active membership.
The source records how they most likely got in: `sso`, `waitlist`, or `open` for accounts older than
the waitlist. The backfill runs only on the call that creates the org; repeating it on every boot would
admit users that some path forgot to admit.

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

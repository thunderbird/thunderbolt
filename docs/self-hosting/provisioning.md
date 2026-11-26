# Provisioning (SCIM)

Single sign-on decides who can sign in. Provisioning decides who exists: your identity provider creates people in Thunderbolt ahead of their first sign-in, updates them, and deactivates or deletes them when they leave. Thunderbolt implements SCIM 2.0 for this at `<BETTER_AUTH_URL>/v1/api/auth/scim/v2`. The endpoint must be reachable from your provider; the desktop and mobile apps don't need to be running.

Use SCIM if you need offboarding to happen without anyone acting in Thunderbolt. **A connection without SCIM can't offboard anyone automatically.** Disabling someone at your provider then only stops their next sign-in; their existing sessions keep working until an admin blocks them, or retires the SSO connection that let them in.

## Connections

A connection is one identity provider scope: one Entra tenant, one Okta org, one Keycloak realm. Each has an SSO side, a SCIM side, or both, and several connections can provision into the same deployment. Each connection has its own credentials and identifiers, so the same `externalId` arriving from two connections is two different people, and one connection's token can't read or change another's users or groups.

An admin creates connections through the admin API:

| Step                          | Call                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Add an SSO side               | `POST /v1/admin/connections/sso` with the provider's OIDC or SAML details and its match claim |
| Add a SCIM side to it         | `POST /v1/admin/connections/scim` with `{ "identityConnectionId": "…" }`                |
| Edit its SSO side             | `PATCH /v1/admin/connections/:id` with any of `name`, `matchClaim`, `oidc: { clientId, clientSecret, discoveryEndpoint }` or `saml: { cert, entryPoint }` |
| Issue another token           | `POST /v1/admin/connections/:id/scim/credentials`                                       |
| Revoke a token                | `POST /v1/admin/connections/:id/scim/credentials/:credentialId/revoke`                  |
| Stop provisioning             | `POST /v1/admin/connections/:id/scim/retire`                                            |

The SSO provider you configure through `OIDC_*` or `SAML_*` is connection `sso`; give it a SCIM side the same way. Its SSO side follows those settings and can't be edited through the API.

A new client secret or certificate takes effect at the next sign-in, and nobody needs to link again. The provider id, the OIDC issuer and the SAML entity ids never change (`SSO_IDENTITY_FIELD_IMMUTABLE`): retire the connection and create another instead. The client id, the discovery URL and the entry point decide which of the provider's identities an account belongs to, so they change only while nobody has signed in through the connection (`SSO_IDENTITY_FIELD_LOCKED`). The match claim also waits for the review queue to hold nothing pending or approved for it (`SSO_MATCH_CLAIM_LOCKED`). A discovery URL must be on a trusted origin, as at sign-in.

### Tokens

- A token is shown once, in the response that issues it. Thunderbolt keeps only a keyed digest.
- Tokens expire after 365 days. Issue the next one before then: the old one keeps working until it is revoked or expires, so you can switch your provider over without a gap.
- **Rotating `BETTER_AUTH_SECRET` invalidates every SCIM token.** The digest key is derived from it. Issue new tokens and update each provider in the same change.
- `GET /v1/admin/connections/:id` shows each token's status, expiry and last use.

### Domains

An admin adds each email domain (`POST /v1/admin/domains`), publishes the TXT record the response names, verifies it, and then claims it for a connection (`PUT /v1/admin/domains/:id/claim`). A claim does two things: the sign-in screen sends that domain straight to the connection, and it lets an existing account on that domain link to the connection's identity without an admin (see [Collisions](#collisions-and-the-review-queue)). On a connection with SCIM that happens when the provider provisions the account. On a connection without SCIM it matters only for an account that already signs in through another provider; any other account links by its verified email, as [Authentication](./authentication.md#what-single-sign-on-looks-like-to-the-user) describes. A claimed domain is closed to domain enrollment, so nobody gets back in that way after your provider removes them.

**Each subdomain is claimed on its own.** A claim on `corp.com` doesn't cover `eu.corp.com`; subdomains are never trusted implicitly.

## The match claim and `externalId`

Thunderbolt links an SSO sign-in to the SCIM record it belongs to by the record's `externalId`, never by email. Each connection names the claim (OIDC) or attribute (SAML) whose value is that `externalId`. Your provider must send the same stable id both ways.

| Provider | SCIM `externalId`                       | Match claim                                        | Notes                                                                                                                       |
| -------- | --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Entra ID | the user's `objectId`                   | `oid` (OIDC), `http://schemas.microsoft.com/identity/claims/objectidentifier` (SAML): the full claim URI, as attribute names match exactly | Entra's default mapping sends `mailNickname` as `externalId`: change it to `objectId`. Entra's `sub` is per app, so never match on it |
| Okta     | the Okta user id                        | `sub`                                              | Okta doesn't send `externalId` by default: map it explicitly in the app's attribute mappings                                 |
| Keycloak | the Keycloak user id (sent by the extension) | `sub` (OIDC), or an attribute carrying the user id (SAML) | No mapping needed under OIDC. Under SAML, add a User Property mapper for `id` and name it as the match attribute               |
| SAML     | a persistent, immutable identifier      | a persistent NameID, or a named immutable attribute | An email-format NameID is email matching under another name: don't use one                                                  |

The Entra and Okta rows come from the providers' documentation and have not been run against real tenants yet. The Keycloak row was validated against Keycloak 26.8.2 (see below).

`externalId` is required on every create and can't change once set. A provider that tries to change it gets an error, because the new id would hand the account to whoever it names.

## What each provider operation does

| Your provider sends   | In Thunderbolt                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| create                | A member, with their email marked verified. Only people the connection provisioned can sign in through its SSO side |
| update                | The profile follows: name, username, email                                                                           |
| `active: false`       | Suspended: signed out, and refused on API keys, sync and WebSockets. Their devices stay trusted                       |
| `active: true`        | Back in. The same devices sync again after they sign in                                                              |
| `DELETE`              | Removed. If that ends their access, their devices are revoked and their sessions and API keys deleted; a member another connection still admits keeps them. The account and its data stay |
| create again after `DELETE`, same `externalId` | The same account, with no trusted device: the person needs their recovery phrase or a passkey to read their old data. Once an admin detached the link, it is a new identity with an existing email instead |
| group changes         | Groups and their members. A group grants Thunderbolt roles only through a mapping an admin made to its id, never its name |

A member managed by a connection that has an SSO side signs in through SSO only: email codes and passkey sign-in are refused, so your provider's MFA and conditional access always apply. Members of a connection with only a SCIM side keep email codes. A member stays managed after `DELETE` until an admin detaches the link (`POST /v1/admin/members/:userId/connections/:connectionId/detach`), so they still can't use an email code or delete their own account in the meantime. Detaching works only once your provider has deleted them, or once the connection's SCIM side is retiring or retired; while the provider still provisions the connection, a suspended or active member is refused. An admin can't detach their own link. Afterwards their other access, such as an invitation, decides whether they get in, and the connection no longer signs them in. If your provider creates them again, the create is joined to their account only as any new identity with an existing email would be (see [Collisions and the review queue](#collisions-and-the-review-queue)).

**Revocation is not a remote wipe.** A revoked device clears its local data the next time it reaches the server. A device that stays offline keeps what it has.

Retained data after `DELETE` is readable only by the person, with their recovery phrase or passkey, unless [organizational key escrow](./configuration.md#organizational-key-escrow) is on; see [Devices and Accounts](../admin/devices.md#organizational-key-escrow) for what escrow changes. Only an admin can delete a removed member's data for good (`DELETE /v1/admin/members/:userId`).

## Collisions and the review queue

An identity arriving with the email of an existing account is joined to that account in one of two ways, and never by email alone:

1. **Domain:** the email's domain is verified and claimed by the connection it arrives on.
2. **Review:** anything else waits for an admin in `GET /v1/admin/link-reviews`. The provider's create gets a `409` until an admin approves (`POST /v1/admin/link-reviews/:id/approve`); its next retry then links.

Two existing accounts are never merged, and a link never changes someone's devices. When two providers manage one person, the first to link keeps managing their name and email.

A Keycloak user deleted and created again gets a new id. With deletion on, that arrives as a new person with an existing email, so it waits for review rather than taking over the old account.

**With the Keycloak extension, an approval needs one more step.** The extension treats the `409` as a create that may have happened, marks it `create_outcome_unknown`, and never sends that create again on its own, so approving the review alone links nothing. After approving, reset that one row in Keycloak's database, as the extension's recovery notes describe, and run **Synchronize all users**:

```sql
UPDATE scim_outbound_resource SET create_uncertain = false, next_attempt = 0
WHERE target_id = '<the SCIM target component id>' AND resource_type = 'Users'
  AND source_id = '<the Keycloak user id>' AND create_uncertain;
```

## Keycloak

Keycloak has no built-in outbound SCIM. Thunderbolt was validated with the third-party [keycloak-scim-outbound](https://github.com/TerminSolutions/keycloak-scim-outbound) extension, branch `termindiego25`, commit `e7c6a33151e22c5a5bcfc277e393e69eb504e138` (1.3.0-SNAPSHOT), on Keycloak 26.8.2. The exact pins are in [`e2e/keycloak/extension.lock`](../../e2e/keycloak/extension.lock).

> **It is third-party, unreleased and GPL-3.0, and Thunderbolt does not support it.** It uses Keycloak's internal SPIs (a custom JPA entity provider and event listener), so a Keycloak upgrade can break it without warning: re-validate on every Keycloak upgrade, and keep it on the Keycloak minor it was built against. Don't use the released 1.2.0 from `master`: it drops failed changes, never sends username changes, has no initial sync, and can hand one person's Thunderbolt account to a different Keycloak user with the same username.

To install it:

1. Build the commit with JDK 21 and Maven 3.9.11 or later (`mvn -DskipTests package`), and copy the jar into `/opt/keycloak/providers/`. [`e2e/keycloak/keycloak.Dockerfile`](../../e2e/keycloak/keycloak.Dockerfile) does this for the local test stack.
2. Start Keycloak with `--spi-events-listener--keycloak-scim-outbound--background-retries=true`, or failed changes wait for the next manual sync.
3. In each realm, add `keycloak-scim-outbound` to **Realm settings → Events → Event listeners**, and turn on admin events.
4. Add a **User Federation → keycloak-scim-outbound** target per Thunderbolt connection: base URL `<BETTER_AUTH_URL>/v1/api/auth/scim/v2`, the connection's token, and:

   | Setting                       | Value          | Why                                                                                             |
   | ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
   | Lookup Mode                   | `externalId`   | Matches on the Keycloak id                                                                      |
   | Adopt Legacy Accounts         | off            | Never binds a match without an `externalId`                                                     |
   | Discover Attribute Mutability | on             |                                                                                                 |
   | Update Work Email             | on             | Email changes reach Thunderbolt                                                                 |
   | Sync Groups                   | on             | If roles come from Keycloak groups                                                              |
   | Deprovision Action            | your choice    | `deactivate` suspends on delete, `delete` removes. Switching to `delete` later also deletes the users it had already deactivated |

5. Run **Synchronize all users** once for the initial load.

Every Keycloak user needs an email address, or set the username strategy to `email`: Thunderbolt refuses users without one. A name change in Keycloak updates the SCIM record's given and family name but not the name Thunderbolt shows: the extension sends no display or formatted name, and Thunderbolt keeps the one it built when the user was created. Not synced: passwords and credentials, custom attributes, nested group hierarchy (subgroups arrive as flat groups), and LDAP-driven changes unless you add the extension's `ldap-sync-notifier` mapper.

## Sizing

With `RATE_LIMIT_ENABLED` on, each SCIM token has a budget of 1,200 requests a minute; past it the provider gets a SCIM `429` with `Retry-After`, waits and resends. The packaged Compose and Helm configurations turn rate limiting off, and then there is no budget. An initial sync costs about 2 requests a user from Entra or Okta (a lookup and a create) and about 5 from the Keycloak extension, which also reads its own writes back. At the budget, an Entra-shaped sync measured about 650 users a minute, so 5,000 users take about 8 minutes. A Keycloak full sync measured about 250 users a minute, so 5,000 users take about 20 minutes. The server itself is not the limit: with the budget off, the same 5,000-user sync on Postgres ran at about 265 requests a second, under 40 seconds in all.

## Outages

Access is decided from Thunderbolt's own records, so an identity provider outage doesn't stop people who are signed in: their sessions, API keys and sync keep working, and nothing on those paths calls the provider. New SSO sign-ins fail until the provider is back, which is why you should keep a [break-glass admin](./authentication.md#what-single-sign-on-looks-like-to-the-user).

When Thunderbolt is unreachable, your provider keeps the changes and sends them when it can reach Thunderbolt again; nothing is lost on Thunderbolt's side. Where to look when provisioning stalls:

- Thunderbolt records the SCIM requests it refuses from a valid token: `GET /v1/admin/audit-events?connectionId=…&action=scim.request&outcome=failure`. It doesn't record a `401`, since the caller isn't known; nor a rate-limit refusal; and it stops after 60 failures per token per hour.
- So a provider whose token stopped working leaves nothing in the audit log. That is what happens to every provider after a `BETTER_AUTH_SECRET` rotation. Watch for it through the token's last use and the provider's own log, below.
- A token's last use (`GET /v1/admin/connections/:id`) going stale means the provider stopped sending.
- Requests that never reach Thunderbolt show only at the provider: Entra and Okta provisioning logs, or for Keycloak its server log (`SCIM work pending … reason=…`) and the extension's own tables.

# Users and Access

Who can sign in to your deployment, and how you change that. The full list of settings lives in
[Configuration](../self-hosting/configuration.md); this page covers the decisions behind them.

## Pick where access is decided

| Mode     | `AUTH_MODE` | Users sign in with                  | You control access from       |
| -------- | ----------- | ----------------------------------- | ----------------------------- |
| Consumer | `consumer`  | An 8-digit code sent to their email | Thunderbolt's waitlist, below |
| OIDC SSO | `oidc`      | Your identity provider              | Your identity provider        |
| SAML SSO | `saml`      | Your identity provider              | Your identity provider        |

An unset `AUTH_MODE` falls back to `consumer`, but the packaged Docker Compose and Kubernetes
deployments both set `oidc` and ship a demo identity provider, so a stock install is on SSO until you
change it. Set the mode explicitly either way. The app build carries the same choice as a build
argument, `VITE_AUTH_MODE` (`sso` for either SSO mode, unset for consumer), so changing modes means
rebuilding the app image as well as restarting the API. The published app image is built with `sso`,
so consumer mode means building that image yourself.
[Authentication](../self-hosting/authentication.md) covers the provider settings.

We recommend SSO if your organization already runs an identity provider. Joining, leaving, and
multi-factor policy then stay where the rest of your accounts are.

Consumer mode has no passwords and no "sign in with Google" button; the emailed code is the only
credential. `GOOGLE_CLIENT_ID` and `MICROSOFT_CLIENT_ID`, if you have set them, let a signed-in user
connect their own mailbox and calendar to the app. They are not a sign-in method.

## Consumer mode sign-in

One message carries both an 8-digit code and a link, and either one signs the person in.

| Property                | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Valid for               | 10 minutes                                                            |
| Wrong attempts allowed  | 3, then the code is dead                                              |
| Resend                  | Sends the same code again, so a resend cannot reset the attempt count |
| Asking for a new code   | Refused for 15 seconds per address                                    |
| Sign-in requests per IP | 10 per minute                                                         |

Typing the code also requires a challenge token issued alongside it, so the eight digits on their own
are not enough. That token is tied to the email address rather than to one browser, and the link in
the same email carries it, so treat the message itself as the credential.

The 15-second cooldown is held in memory by the process that served the request, so it is weaker on a
deployment running several workers or replicas. The per-IP limit is recorded in the database and so is
shared across them, unless you set `RATE_LIMIT_ENABLED=false`, which turns it off everywhere.

> Without `RESEND_API_KEY` no sign-in email is sent. Outside production the API logs the code and
> link instead, which is enough for a local evaluation. On `NODE_ENV=production`, which both the
> packaged Compose and Helm deployments set, the send throws and the request fails, so consumer mode
> needs the key.

## The waitlist

In consumer mode, every email address that has never signed in is queued, and no setting turns that
off: `WAITLIST_ENABLED` is accepted and validated but currently has no effect, and the app build
setting `VITE_BYPASS_WAITLIST` only hides the waitlist screen while the API still queues.

> On a fresh deployment running consumer mode, nobody new can sign in until you act on this.

### Auto-approve your own domains

Domain auto-approval is the API's only approval setting, and for most team deployments it is all you
need:

```bash
WAITLIST_AUTO_APPROVE_DOMAINS=example.com,example.org
```

An address whose domain is exactly one of the listed entries is approved the first time it asks and
gets a code immediately. Matching uses the part after the last `@` and ignores case. Subdomains are
not covered, so list `mail.example.com` separately if you need it. Settings are read once at
startup, so restart the API after changing this.

### Approve one address

Approval is a row in the `waitlist` table of your PostgreSQL database; no API route or command sets
it. Ask the person to request a code once, which creates their row, then approve it.

```sql
UPDATE waitlist SET status = 'approved', updated_at = now()
WHERE email = 'person@example.com';
```

To approve someone who has never tried:

```sql
INSERT INTO waitlist (id, email, status)
VALUES (gen_random_uuid()::text, 'person@example.com', 'approved');
```

Addresses are stored lowercase and trimmed. On a Docker Compose deployment, reach the database with:

```bash
docker compose exec postgres psql -U postgres -d postgres
```

The person can sign in on their next attempt. Nothing notifies them, so tell them yourself.

### Who gets a code

The API works down this list and stops at the first match.

| Order | The address                        | Result                                             |
| ----- | ---------------------------------- | -------------------------------------------------- |
| 1     | Already has an account             | Code sent. Past the gate once, never queued again  |
| 2     | Is marked approved on the waitlist | Code sent                                          |
| 3     | Ends in a domain you auto-approve  | Code sent, and the address is recorded as approved |
| 4     | Anything else                      | Queued. No code                                    |

Every well-formed request returns the same `200`, so the failure modes an enumerator looks for, a 404
or an "already registered" error, do not exist. The body does differ: an approved address gets a
challenge token and a queued one does not, so the endpoint reveals whether an address is approved. It
cannot distinguish an existing account from an approved waitlist row.

### What the person receives

| Their situation              | Email                     |
| ---------------------------- | ------------------------- |
| Approved                     | The sign-in code and link |
| Newly queued                 | "You are on the list"     |
| Already queued, asked again  | A reminder                |
| Queued, but tried to sign in | "Not ready yet"           |

Each email is written in the language the person's app is set to. A queued user still sees the "check
your email" screen with a code box, because the screen does not disclose which branch the API took.
Expect the occasional report that a code never arrived.

## Anonymous access

Visitors can use the app with no account at all. Anonymous access is off by default and takes two
settings that have to agree: `AUTH_ALLOW_ANONYMOUS=true` on the API and
`VITE_AUTH_ENABLE_ANONYMOUS=true` in the app build. It is not available under SSO.

The app build also has to drop the waitlist screen with `VITE_BYPASS_WAITLIST=true`, or visitors are
still sent to a sign-in wall. Set `VITE_BYPASS_WAITLIST` on its own and unauthenticated visitors
land on a not-found page, so use both or neither.

Both app settings are read when the app is built, and neither is offered as a build argument on the
published app image, so turning anonymous access on means building that image yourself. The API
setting is an ordinary environment variable and takes effect on restart.

With `AUTH_ALLOW_ANONYMOUS` off, the API has no anonymous sign-in endpoint at all, so a modified or
hand-rolled client cannot create an anonymous session either.

| Capability                          | Anonymous visitor                   |
| ----------------------------------- | ----------------------------------- |
| Chat, with data kept on that device | Yes                                 |
| Sync to their other devices         | No, there is no account to sync to  |
| Approving a command-line sign-in    | No, they are asked to sign in first |
| Spend on the models you provide     | A much smaller allowance            |

The allowance is tighter because an anonymous session costs an attacker nothing to create. By
default it is 10 cents per rolling 5 hours and 60 cents per rolling 7 days, against 1500 and 7500
cents for a signed-in account.

All four are set by the `INFERENCE_QUOTA_*` settings in [Models](../self-hosting/models.md), and
they only apply to models your deployment provides. A user running against their own provider key
spends their own money and is not metered here.

If an anonymous visitor signs in later, the work already on their device carries into the new account
and the anonymous record is removed.

Anonymous visitors are never waitlist-gated.

> Turning anonymous access on means anyone who can reach the URL can use the deployment. Put it
> behind your network perimeter if that is not what you want.

## SSO deployments

Under `AUTH_MODE=oidc` or `saml` the sign-in screen becomes a redirect to your identity provider and
the waitlist never runs. Provisioning, deprovisioning, multi-factor, and group membership are your
provider's job.

- Add the provider's origin to `TRUSTED_ORIGINS`, not `CORS_ORIGINS`. Containerized deployments
  usually need two entries: the origin the browser sees and the internal hostname the API uses.
- An identity from your provider is linked onto an existing account with the same email address, so a
  deployment can move from email codes to SSO without stranding accounts.

There is no SCIM endpoint and no provisioning ahead of first use; an account exists once the person
signs in for the first time.

## Removing access

| Goal                             | How                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Offboard someone (SSO)           | Disable or remove them in your identity provider                                                                                          |
| Offboard someone (consumer mode) | Delete their row from the `user` table. Setting their waitlist row back to `pending` does nothing: an existing account is never re-queued |
| Cut off one lost laptop or phone | The user revokes it under **Settings → Devices**                                                                                          |
| Remove a person's data entirely  | The user does it under **Settings → Preferences → Data**, or you delete their `user` row, which cascades to their synced data             |

Deleting the account stops new requests at once. Each of their devices that has sync on notices on
its next check with the API, clears its local copy, and shows an account-deleted screen. A signed-in
device with sync off only sees its session fail and is asked to sign in again, and keeps its local
copy; so does a device that stays offline. Treat device recovery as a separate step for a high-stakes
departure.

Revoking a single device stops that device syncing and cuts its sessions, and the person is asked
whether to keep or erase the local copy.

## Programmatic access

Users can mint personal access tokens for scripts and the command-line client. A token authenticates
as its owner and carries that person's full access; there are no scopes.

| Property                 | Value                                                        |
| ------------------------ | ------------------------------------------------------------ |
| Default lifetime         | 90 days, set by `API_KEY_DEFAULT_EXPIRES_IN` in seconds      |
| Per-token lifetime       | 1 to 365 days, chosen when the token is created              |
| Where tokens are created | By a call to the API. There is no screen for this in the app |
| Confidential models      | Refused unless you set `CONFIDENTIAL_API_KEYS_ENABLED=true`  |

Confidential models are the tier that runs inside verified secure hardware, described in
[Models](../self-hosting/models.md). A token is refused there by default because it lives far longer
than a browser session. Turning the setting on does not help the command-line client, which refuses a
confidential model on a token of its own accord; the setting is for service callers.

Signing in from the command-line client uses a browser approval step instead, and the user must
already have a real account.

## What Thunderbolt does not have

- **No administrator console:** every lever on this page is an environment variable or a database row.
- **No roles, groups, or permissions:** every account can do the same things.
- **No bulk invite or import**, and no directory sync.
- **No central model policy:** a user can add their own model provider and key inside the app, so the
  providers you configure on the API are a default, not a restriction.
- **No view into another user's tokens, devices, or conversations:** nothing in the product exposes
  them, and with end-to-end encryption turned on the server cannot read message content or chat titles
  at all.

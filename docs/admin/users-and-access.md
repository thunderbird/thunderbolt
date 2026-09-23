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

If your organization already runs an identity provider, use SSO. Joining, leaving, and multi-factor
policy then stay where the rest of your accounts are, and Thunderbolt's waitlist never runs.

Consumer mode has no passwords and no "sign in with Google" button. The emailed code is the only
credential. `GOOGLE_CLIENT_ID` and `MICROSOFT_CLIENT_ID`, if you have set them, let a signed-in user
connect their own mailbox and calendar to the app. They are not a sign-in method.

## Consumer mode sign-in

One message carries both an 8-digit code and a link. They are the same credential, so either one
signs the person in.

| Property                | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Valid for               | 10 minutes                                                            |
| Wrong attempts allowed  | 3, then the code is dead                                              |
| Resend                  | Sends the same code again, so a resend cannot reset the attempt count |
| Asking for a new code   | Refused for 15 seconds per address                                    |
| Sign-in requests per IP | 10 per minute                                                         |

The code has to be typed into the same browser or app that asked for it, so a code read over someone's
shoulder is not on its own enough to sign in. The link in the same email carries its own
authorization and works anywhere, so treat the message itself as the credential.

The 15-second cooldown is held in memory by the process that served the request, so it is weaker on a
deployment running several workers or replicas. The per-IP limit is recorded in the database and so is
shared across them, unless you set `RATE_LIMIT_ENABLED=false`, which turns it off everywhere.

**Email has to work.** Without `RESEND_API_KEY` the API never sends a sign-in email; it writes the
code and link to its own log instead. That is usable for evaluation and useless for real users.

## The waitlist

In consumer mode, every email address that has never signed in is queued. This is always on.
`WAITLIST_ENABLED` is accepted and validated but currently has no effect, and the app build setting
`VITE_BYPASS_WAITLIST` only hides the waitlist screen. The API still queues.

**On a fresh deployment running consumer mode, nobody new can sign in until you act on this.** SSO
deployments are unaffected.

### Auto-approve your own domains

The only server-side lever, and for most team deployments the whole story:

```bash
WAITLIST_AUTO_APPROVE_DOMAINS=example.com,example.org
```

Any address ending in a listed domain is approved the first time it asks and gets a code
immediately. Matching uses the part after the last `@` and ignores case. Settings are read once at
startup, so restart the API after changing this.

### Approve one address

There is no admin console, API route, or command for this. Approval is a row in the `waitlist` table
of your PostgreSQL database.

Ask the person to request a code once, which creates their row, then approve it.

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

Checked in this order. The first match wins.

| Order | The address                        | Result                                             |
| ----- | ---------------------------------- | -------------------------------------------------- |
| 1     | Already has an account             | Code sent. Past the gate once, never queued again  |
| 2     | Is marked approved on the waitlist | Code sent                                          |
| 3     | Ends in a domain you auto-approve  | Code sent, and the address is recorded as approved |
| 4     | Anything else                      | Queued. No code                                    |

Every well-formed request answers the same way, with the same status and the same wording, whether the
address is brand new, queued, approved, or an existing account. That is deliberate: the sign-in form
cannot be used to find out who already has an account here.

### What the person receives

| Their situation              | Email                     |
| ---------------------------- | ------------------------- |
| Approved                     | The sign-in code and link |
| Newly queued                 | "You are on the list"     |
| Already queued, asked again  | A reminder                |
| Queued, but tried to sign in | "Not ready yet"           |

Each email is written in the language the person's app is set to.

A queued user still sees the "check your email" screen with a code box, because the screen does not
disclose which branch the API took. Expect the occasional report that a code never arrived.

## Anonymous access

Visitors can use the app with no account at all. It is off by default and needs two settings that
must agree:

| Where     | Setting                           |
| --------- | --------------------------------- |
| API       | `AUTH_ALLOW_ANONYMOUS=true`       |
| App build | `VITE_AUTH_ENABLE_ANONYMOUS=true` |

The app build also has to drop the waitlist screen with `VITE_BYPASS_WAITLIST=true`, or visitors are
still sent to a sign-in wall. Set `VITE_BYPASS_WAITLIST` on its own and unauthenticated visitors land
on a not-found page, so use both or neither. Anonymous access is not available under SSO.

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

An anonymous session costs an attacker nothing to create, which is why the spending allowance is much
tighter by default: 10 cents per rolling 5 hours and 60 cents per rolling 7 days, against 1500 and
7500 cents for a signed-in account. All four are set by the `INFERENCE_QUOTA_*` settings in
[Models](../self-hosting/models.md), and they only apply to models your deployment provides. A user
running against their own provider key spends their own money and is not metered here.

If an anonymous visitor signs in later, the work already on their device carries into the new account
and the anonymous record is removed.

**Anonymous visitors are never waitlist-gated.** Trying the app without an account is the point of the
feature. Turning it on means anyone who can reach the URL can use the deployment, so put it behind
your network perimeter if that is not what you want.

## SSO deployments

Under `AUTH_MODE=oidc` or `saml` the sign-in screen becomes a redirect to your identity provider and
the waitlist never runs. Provisioning, deprovisioning, multi-factor, and group membership are your
provider's job.

- Add the provider's origin to `TRUSTED_ORIGINS`, not `CORS_ORIGINS`. Containerized deployments
  usually need two entries: the origin the browser sees and the internal hostname the API uses.
- An identity from your provider is linked onto an existing account with the same email address.
  That is what lets a deployment move from email codes to SSO without stranding accounts.

There is no SCIM endpoint and no provisioning ahead of first use. An account exists once the person
signs in for the first time.

## Removing access

| Goal                             | How                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Offboard someone (SSO)           | Disable or remove them in your identity provider                                                                                          |
| Offboard someone (consumer mode) | Delete their row from the `user` table. Setting their waitlist row back to `pending` does nothing: an existing account is never re-queued |
| Cut off one lost laptop or phone | The user revokes it under **Settings → Devices**                                                                                          |
| Remove a person's data entirely  | The user does it under **Settings → Preferences → Data**, or you delete their `user` row, which cascades to their synced data             |

Deleting the account stops new requests at once. Each of their signed-in devices notices on its next
check with the API, clears its local copy, and shows an account-deleted screen. A device that is
offline and stays offline keeps what it has, so treat device recovery as a separate step for a
high-stakes departure.

Revoking a single device is different on purpose: it stops that device syncing and cuts its sessions,
and the person is asked whether to keep or erase the local copy.

## Programmatic access

Users can mint personal access tokens for scripts and the command-line client. A token authenticates
as its owner and carries that person's full access. There are no scopes.

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
already have a real account. An anonymous session cannot approve one.

## What Thunderbolt does not have

- **No administrator console.** Every lever on this page is an environment variable or a database row.
- **No roles, groups, or permissions.** Every account can do the same things.
- **No bulk invite or import**, and no directory sync.
- **No central model policy.** A user can add their own model provider and key inside the app, so the
  providers you configure on the API are a default, not a restriction.
- **No view into another user's tokens, devices, or conversations.** Nothing in the product exposes
  them, and with end-to-end encryption turned on the server cannot read message content or chat titles
  at all.

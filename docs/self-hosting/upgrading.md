# Upgrading

There is no in-place updater and no upgrade button. You set a new version, apply it, and the services restart. Two parts of that are not reversible by rerunning the command: database migrations, and the state held by the bundled Keycloak.

## Before you upgrade

> Back up the database first. Schema changes are applied automatically, and going back to an old image does not undo them.

Note the version you are on, because you need it to roll back. `CHANGELOG.md` in the repository lists every version and what changed in it, so read the entry for the version you are moving to. Pick an explicit version rather than `latest`, for the reason in the warning below. And expect a short interruption on Docker Compose, and on the AWS database task. The Helm path rolls one pod at a time, so it normally has none.

There is no endpoint that reports the running version, so read it from whichever tool you deployed with:

```bash
# Docker Compose: the tag your checkout is on
git -C thunderbolt describe --tags

# Kubernetes: the image tag each deployment is actually running
kubectl -n thunderbolt get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'

# AWS with Pulumi
pulumi config get version -s <stack-name>
```

**Settings → Preferences → App Version** shows the version of the app a client has loaded, signed in or not.

## How versions are published

Each version publishes six container images to the GitHub Container Registry, all tagged with that version number:

| Image                                                   | What it is                     |
| ------------------------------------------------------- | ------------------------------ |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-frontend`  | The app served to the browser  |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-backend`   | The API                        |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-postgres`  | PostgreSQL, preconfigured      |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` | The sync service               |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-keycloak`  | The bundled identity provider  |
| `ghcr.io/thunderbird/thunderbolt/thunderbolt-marketing` | The landing page and this site |

The Helm chart is published alongside them, at the same version:

```bash
helm show chart oci://ghcr.io/thunderbird/charts/thunderbolt
```

All six images and the chart are published together under one version number, such as `0.1.133`, so pin every component to the same one.

Kubernetes uses only three of the six: the Helm chart runs stock PostgreSQL, sync-service and Keycloak images from their own publishers rather than the packaged ones, which is why a Helm upgrade sets three image tags. The AWS path uses all six.

Version numbers are not frozen, either. The images are rebuilt and republished under the same tag on every merge to the main branch that touches the app, the API or the deployment files, until the next version bump moves the number on. Two pulls of `0.1.133` a week apart are not guaranteed to be the same build. If you need a build you can prove is unchanged, record the image digest at deploy time and pin to that.

> **`latest` is not a release channel.** It is rebuilt on every merge that touches the app, the API or the deployment files, and again each night, so it can change under you between two runs of the same command. Set an explicit version tag for anything other than a throwaway evaluation.
>
> The Helm chart ships `latest` as its default image tag with a pull policy of `IfNotPresent`. On a node that already holds an image tagged `latest`, an upgrade will reuse the old one and appear to do nothing. This is the most common cause of "the upgrade ran but nothing changed".

## Single sign-on changes

If you run SAML or OIDC and upgrade to a release after 0.1.144, four things change. The [rate limiting changes](#rate-limiting-changes) below apply to you as well.

1. **SAML logins that start at the provider's dashboard are refused.** The user lands on the app's sign-in error page and signs in again from the app. Point the dashboard icon at your app's address, or set `SAML_ALLOW_IDP_INITIATED=true` after reading the risk. See [Authentication](./authentication.md#logging-in-from-the-providers-dashboard).
2. **A failed or cancelled sign-in returns to the app.** The user sees a message and a "Try again" button instead of a plain error page on the API address.
3. **A new identity from your provider links to an existing account only in two cases.** Either the account's email is verified (its owner signed in with an emailed code), or the account already has an identity from your provider. That second case covers switching `AUTH_MODE` between `oidc` and `saml`, moving to a different provider, and a provider that changes a user's subject or NameID. Any other account with the same address gets "account not linked". Under OIDC, a user whose provider reports `email_verified` as false is never linked, so mark the address verified at the provider. Keycloak sets it only when the realm makes users confirm the address ("Verify email") or an admin ticks "Email verified". SAML has no such claim. See [Authentication](./authentication.md#what-single-sign-on-looks-like-to-the-user).
4. **Only the provider you configured can sign anyone in.** Earlier releases let any signed-in user add another provider through the API. Those rows stay in the `sso_provider` table, but they can no longer sign anyone in, create accounts, or be edited. We recommend deleting them, and the accounts linked through them. List the rows first:

   ```sql
   SELECT provider_id, issuer, domain, user_id, created_at FROM sso_provider WHERE provider_id <> 'sso';
   ```

   Before this release, the owner of such a row could sign in through it with an identity provider they ran. An email address with no account yet got a new account, and they were signed in to it. The address of an existing account got "account not linked". But if the real owner of an address later signed in through your provider, they were linked to the account the row had created, and the row's owner could sign in to it too.

   To see whether a row was used, list the accounts linked through it:

   ```sql
   SELECT user_id, provider_id, created_at FROM account
   WHERE provider_id IN (SELECT provider_id FROM sso_provider WHERE provider_id <> 'sso');
   ```

   An empty result does not prove a row was never used. Its owner could have deleted it through the API, which left its accounts behind. Nothing ties `account.provider_id` to `sso_provider`, so look for names you don't recognize among every provider in use:

   ```sql
   SELECT provider_id, count(*) FROM account GROUP BY provider_id;
   ```

   If the accounts query returned rows, deleting those accounts does not undo what the row's owner set up while signed in. List the open sessions, API keys and passkeys of those users, with the `user_id` values it returned:

   ```sql
   SELECT user_id, created_at, expires_at FROM session WHERE expires_at > now() AND user_id IN ('<user_id>');
   SELECT reference_id, name, created_at FROM apikey WHERE reference_id IN ('<user_id>');
   SELECT user_id, name, created_at FROM passkey WHERE user_id IN ('<user_id>');
   ```

   Consider deleting the ones the person does not recognize. Leave other users' sessions alone.

   End-to-end encryption is a fourth thing the row's owner may hold. If the owner signed in to an account the row created, they could have set up encryption, approved their own device and seen the recovery key, a 24-word phrase shown once. Deleting the `account` rows below does not take any of that back. List the devices that can still open the account's data:

   ```sql
   SELECT user_id, id, name, device_type, trusted, created_at, last_seen
   FROM powersync.devices WHERE revoked_at IS NULL AND user_id IN ('<user_id>');
   SELECT device_id, user_id, created_at FROM envelopes WHERE user_id IN ('<user_id>');
   ```

   Each row in `envelopes` is a copy of the account key sealed to one device, and the recovery phrase has its own slot. An empty `envelopes` result means the account never set up encryption.

   You cannot revoke a device for the user from the database or the API. Revoking needs a signature made with the account's keys, so only a trusted device of that account can do it. Deleting the `envelopes` row, or setting `revoked_at`, would not change the keys the device already holds, and it would skip the key rotation that locks the device out. The supported path is for the person who owns the account to open **Settings > Devices** on a trusted device, revoke each device they do not recognize, and then run **Change recovery phrase** (it asks for an 8-digit code sent to their email). Revoking replaces the account key and the data keys. Changing the phrase makes the old phrase stop working. Neither re-encrypts any data.

   If nobody legitimate uses the account, which is the usual case when the row's owner created it, delete the account instead. Deleting the `user` row cascades to its devices, envelopes and synced data. That is a hard delete and none of it comes back, so do it only for an account you know nobody uses.

   Then delete the accounts, before the rows they point to:

   ```sql
   DELETE FROM account WHERE provider_id IN (SELECT provider_id FROM sso_provider WHERE provider_id <> 'sso');
   DELETE FROM sso_provider WHERE provider_id <> 'sso';
   ```

   Thunderbolt itself writes only `sso` accounts. Any other name in the `GROUP BY` result came from a provider row that is gone. Check and delete its accounts the same way, naming it in place of the subquery.

## Rate limiting changes

These apply to every sign-in mode, email codes included, when you upgrade to a release after 0.1.144.

The built-in authentication limiter keys each request on the client address it reads from a header: the one `TRUSTED_PROXY` names, or `X-Forwarded-For` when it is empty. Before, a request without that header skipped the limit, and an `X-Forwarded-For` holding several addresses counted against the first one. Now both share one bucket per route with every other request the limiter cannot place. The header is missing when nothing in front of the API adds it. It holds several addresses when the request crossed two or more proxies.

A shared bucket fills fast. Entering an emailed sign-in code (`/sign-in/email-otp`) allows 3 requests per 60 seconds, so behind such a proxy only three people a minute can finish signing in with a code. Requesting the code itself (`/email-otp/send-verification-otp`) has the same limit when a client calls it directly. Many users then get `429` at the same time. Set `TRUSTED_PROXY` to `cloudflare` or `akamai` if one of them sits in front of the API. See [Configuration](./configuration.md#rate-limiting) for the other buckets.

## Order of upgrade

Within a single version, apply in this order:

1. **Database:** if you run your own PostgreSQL, it must be reachable and accepting connections first. The API waits up to 90 seconds for it, then runs migrations, then serves; an unreachable database means the container retries for that long and exits.
2. **Sync service:** if the release changes which data is synced, the sync service must be running the new rules before clients that expect them.
3. **API:** applies database migrations on startup, then starts serving.
4. **App and landing page:** static, so these can go last with no coordination.

Helm and Pulumi apply everything in one command and give you no ordering control. That is fine for a normal version-to-version upgrade, because the API refuses to serve until the database answers. If a release note calls for a staged rollout, do it by upgrading one component's tag at a time.

## Docker Compose

This path builds the app and API from source rather than pulling published images, so an upgrade is a source update plus a rebuild.

```bash
cd thunderbolt
git fetch --tags
git checkout v0.1.133     # or: git pull, to track the main branch
cd deploy
docker compose pull       # refreshes PostgreSQL, the sync service and Keycloak
docker compose up -d --build
```

The database volume (`pg_data`) is preserved. Migrations run when the API container starts. Watch them:

```bash
docker compose logs -f backend
```

Compare `deploy/.env` against `deploy/.env.example` after a source update. New settings appear in the example file, and an unset one falls back to its default without warning.

## Kubernetes

Upgrade in place with Helm, setting the new version on every image:

```bash
cd thunderbolt/deploy/k8s
git checkout v0.1.133

helm upgrade thunderbolt . -n thunderbolt \
  --reuse-values \
  --set frontend.image.tag=0.1.133 \
  --set backend.image.tag=0.1.133 \
  --set marketing.image.tag=0.1.133
```

Or from the published chart, without a checkout:

```bash
helm upgrade thunderbolt oci://ghcr.io/thunderbird/charts/thunderbolt \
  --version 0.1.133 -n thunderbolt --reuse-values \
  --set frontend.image.tag=0.1.133 \
  --set backend.image.tag=0.1.133 \
  --set marketing.image.tag=0.1.133
```

`--reuse-values` keeps the values you installed with, including your session secret. Drop it only if you are passing the full set again.

Watch the rollout:

```bash
kubectl get pods -n thunderbolt -w
kubectl logs -n thunderbolt deploy/backend -f
```

Helm's rolling update keeps the old API pod serving until the new one passes its readiness probe, and the new pod holds off readiness until migrations finish, so the swap is usually seamless. On AWS the API task overlaps in the same way. The bundled PostgreSQL task does not: it is stopped before its replacement starts, since two copies cannot safely share one volume, so expect roughly 30 seconds with no database.

Most values are rendered into the pod definition, so changing one rolls that deployment by itself. Values rendered into mounted configuration instead, such as the Keycloak realm or the sync rules, take effect only when the pod is replaced, which you force with `kubectl rollout restart deployment/<name> -n thunderbolt`.

The database keeps its persistent volume across upgrades and across an uninstall. Deleting the claim loses it, and so does deleting the namespace.

## AWS with Pulumi

Change the version and reapply. Nothing is built.

```bash
cd thunderbolt/deploy/pulumi
pulumi config set version 0.1.133 -s <stack-name>
pulumi preview -s <stack-name>
pulumi up -s <stack-name>
```

Always run `pulumi preview` first. It shows exactly which resources will be replaced, which is where you catch an unintended database or storage replacement before it happens.

If you deploy through the repository's stack workflow instead, pass the same version as the `version` input.

## Database migrations

Migrations run automatically, each time the API container starts, before it accepts traffic. You never run one by hand. `SKIP_MIGRATIONS=true` stops the API applying them in-process, but the container image's entrypoint runs `drizzle-kit migrate` before the server starts regardless, so migrating separately means overriding the container command as well. They are **not** reversible: migrations are forward-only, and there are no down migrations. The whole run goes in one transaction, so if any migration fails the rest roll back with it, the container exits, and the reason is in its log.

Forward-only also means going back to an older image does not undo a schema change. Some releases drop columns or tables, and an older API against a newer schema may fail. A database backup taken before the upgrade is the only real rollback for a schema change.

## Sync rules

The sync service decides which data reaches a device, and it reads that from a configuration file. Where the file comes from depends on how you deploy:

| Deployment     | Where the sync rules come from                      | What that means for an upgrade        |
| -------------- | --------------------------------------------------- | ------------------------------------- |
| Docker Compose | A file in your checkout, mounted into the container | Updating the source updates the rules |
| Kubernetes     | The Helm chart                                      | Upgrading the chart updates the rules |
| AWS            | Built into the packaged sync-service image          | Moving the version updates the rules  |

A rule change takes effect only when the sync service restarts. On Kubernetes, changing the configuration does not trigger that, so roll the sync deployment by hand after a chart upgrade that changes the rules.

> If a release adds newly synced data and only the app is upgraded, the feature works on the device it was used on and silently fails to appear on the user's other devices.

## Client apps

Browsers pick up an upgrade on reload. Nothing is installed, so there is no user action beyond refreshing the page. The desktop and mobile apps upgrade separately, through their own release channels, and both are built against a fixed server address, so a self-hosted deployment needs its own builds.

Data already synced to a device stays on that device through a server upgrade. Devices catch up with the server when they reconnect.

A version can also change the models, skills and tasks the app ships with. Those are rows in each user's own data, updated on the next load: rows the user has edited or deleted are left as they are, the rest are refreshed. A **model** the new version retires is the exception: its row is soft-deleted even if the user had customised it, and its tuning profile goes with it. Retired default skills and tasks are left in place.

If a release is not backwards compatible with older clients, set `MIN_APP_VERSION` to the lowest version you want to allow. Clients below it are refused with `426 Upgrade Required`. It is read once at startup, so restart the API after changing it. Leave it empty to accept any client. See [Configuration](./configuration.md#minimum-client-version).

## Rolling back

Rolling back replaces the images. It does not replace the database.

**Docker Compose**

```bash
cd thunderbolt
git checkout v0.1.132
cd deploy
docker compose up -d --build
```

**Kubernetes**

```bash
helm history thunderbolt -n thunderbolt
helm rollback thunderbolt <revision> -n thunderbolt
```

**AWS with Pulumi**

```bash
pulumi config set version 0.1.132 -s <stack-name>
pulumi up -s <stack-name>
```

> Check whether the release you are leaving included a migration. If it did, restore the database from your pre-upgrade backup at the same time, or the older API meets a schema it does not expect.

## The bundled Keycloak

The Keycloak that ships with the deployment runs in development mode with no storage of its own. Its realm is imported on the first boot of an empty Keycloak database, and that database lives inside the container with no volume. So **a new container or pod starts from the realm file and discards anything configured in its admin console**, including users you created there and client settings you changed. Restarting the same container keeps them. Upgrading the image replaces the container.

We recommend pointing the deployment at your own identity provider, which upgrades never touch. If you keep the bundled one, put its configuration in the realm file the deployment imports so a restart reproduces it. See [Configuration](./configuration.md#authentication).

The bundled PostgreSQL needs the same care for a different reason. Its major version is pinned per release and its data directory is tied to that major, and a release can move it: the packaged image and the Compose and Helm defaults have not always been on the same major. An existing data directory will not start under a new one. Read the release notes before upgrading, and plan a `pg_upgrade` or a dump and restore when the major moves.

## After the upgrade

```bash
curl -s https://your-host/v1/health                      # {"status":"ok"}, no auth needed
curl -s https://your-host/v1/config                      # JSON, no auth needed
```

A green `/v1/health` means the API process is answering and nothing more. It does not touch the database, the sync service or your model provider.

If you have set `MONITORING_TOKEN`, the deeper checks confirm each dependency individually:

```bash
curl -s -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/database
curl -s -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/powersync
curl -s -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/email
curl -s -H "Authorization: Bearer $MONITORING_TOKEN" https://your-host/v1/health/models
```

`/v1/health/models` sends a real request to every preconfigured model, so it costs money, and a model with no key on the server counts as a failure. It is the only check that proves inference still works after an upgrade.

Then do the end-to-end check by hand, because the probes do not cover it:

1. Sign in from a private browser window. This exercises the identity provider and the session path.
2. Send a message and get a reply, which covers the API and your model provider.
3. Open a second window and confirm the same conversation appears there. That is the sync path.

## What is not automated

Nothing tells you a new version exists, and nothing checks that your images, chart and configuration are all at the same version. No backup of your database is taken before an upgrade, and since migrations only go forward there is no automated schema rollback. New configuration settings are not reported to you either, so compare your configuration against the example configuration after each upgrade. The bundled Keycloak's state is not preserved across a container replacement.

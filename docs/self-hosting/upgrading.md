# Upgrading

There is no in-place updater and no upgrade button. You set a new version, apply it, and the services restart. Two parts of that are not reversible by rerunning the command: database migrations, and the state held by the bundled Keycloak.

## Before you upgrade

Back up the database first: schema changes are applied automatically, and going back to an old image does not undo them. Note the version you are on, because you need it to roll back. `CHANGELOG.md` in the repository lists every version and what changed in it, so read the entry for the version you are moving to. Pick an explicit version rather than `latest`, for the reason in the warning below. And expect a short interruption: each service runs a single copy by default, so restarting it is a gap in service.

There is no endpoint that reports the running version, so read it from whichever tool you deployed with:

```bash
# Docker Compose: the tag your checkout is on
git -C thunderbolt describe --tags

# Kubernetes: the image tag each deployment is actually running
kubectl -n thunderbolt get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'

# AWS with Pulumi
pulumi config get version -s <stack-name>
```

Signed-in users can also check **Settings → Preferences → App Version**, which shows the version of the app they have loaded.

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

> **`latest` is not a release channel.** It is rebuilt on every merge to the main branch and again each night, so it can change under you between two runs of the same command. Set an explicit version tag for anything other than a throwaway evaluation.
>
> The Helm chart ships `latest` as its default image tag with a pull policy of `IfNotPresent`. On a node that already holds an image tagged `latest`, an upgrade will reuse the old one and appear to do nothing. This is the most common cause of "the upgrade ran but nothing changed".

## Order of upgrade

Within a single version, apply in this order:

1. **Database:** if you run your own PostgreSQL, it must be reachable and accepting connections first. The API runs migrations before it serves anything, so an unreachable database means the container exits on startup.
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

Expect the API to be briefly unavailable while this happens: it runs one replica by default and holds off serving until migrations finish.

Changing a configuration value on its own does not restart anything. Values that are rendered into configuration rather than into the pod definition, such as the Keycloak realm or the sync rules, take effect only when the pod is replaced, which you force with `kubectl rollout restart deployment/<name> -n thunderbolt`.

The database keeps its persistent volume across upgrades and across an uninstall. Deleting the volume claim is the only way to lose it.

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

Migrations run automatically, each time the API container starts, before it accepts traffic. You never run one by hand, and you cannot skip them: the API will not start without applying them. They are also **not** reversible: migrations are forward-only, and there are no down migrations. If one fails, the container exits and the reason is in its log. Any changes that already succeeded in that run stay applied.

Forward-only also means going back to an older image does not undo a schema change. Some releases drop columns or tables, and an older API against a newer schema may fail. A database backup taken before the upgrade is the only real rollback for a schema change.

## Sync rules

The sync service decides which data reaches a device, and it reads that from a configuration file. Where the file comes from depends on how you deploy:

| Deployment     | Where the sync rules come from                      | What that means for an upgrade        |
| -------------- | --------------------------------------------------- | ------------------------------------- |
| Docker Compose | A file in your checkout, mounted into the container | Updating the source updates the rules |
| Kubernetes     | The Helm chart                                      | Upgrading the chart updates the rules |
| AWS            | Built into the packaged sync-service image          | Moving the version updates the rules  |

A rule change takes effect only when the sync service restarts. On Kubernetes, changing the configuration does not trigger that, so roll the sync deployment by hand after a chart upgrade that changes the rules.

If a release adds newly synced data and only the app is upgraded, the feature works on the device it was used on and silently fails to appear on the user's other devices.

## Client apps

Browsers pick up an upgrade on reload. Nothing is installed, so there is no user action beyond refreshing the page. The desktop and mobile apps upgrade separately, through their own release channels, and both are built against a fixed server address, so a self-hosted deployment needs its own builds.

Data already synced to a device stays on that device through a server upgrade. Devices reconcile against the server when they reconnect.

A version can also change the models, skills and tasks the app ships with. Those are rows in each user's own data, reconciled on the next load: rows the user has edited or deleted are left as they are, the rest are updated.

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

Before you roll back, check whether the release you are leaving included a migration. If it did, restore the database from your pre-upgrade backup at the same time. Otherwise the older API meets a schema it does not expect.

## The bundled Keycloak

The Keycloak that ships with the deployment runs in development mode with no storage of its own. Its realm is imported from configuration every time the container starts, and **replacing the Keycloak container discards everything configured inside Keycloak since it last started**, including users you created there and client settings you changed in its admin console. Upgrading its image replaces the container.

You can live with that in two ways. Keep Keycloak's configuration in the realm file the deployment imports, so a restart reproduces it. Or point the deployment at your own identity provider instead, which upgrades never touch. See [Configuration](./configuration.md#authentication).

The same applies to the bundled PostgreSQL in one narrower case: its major version is pinned, and its data directory is tied to that major version. An upgrade of Thunderbolt never changes it. Moving PostgreSQL to a new major version is a separate migration you perform yourself.

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

`/v1/health/models` sends a real request to every model you supply a key for, so it costs money. It is also the only check that proves inference still works after an upgrade.

Then do the end-to-end check by hand, because the probes do not cover it:

1. Sign in from a private browser window. This exercises the identity provider and the session path.
2. Send a message and get a reply, which covers the API and your model provider.
3. Open a second window and confirm the same conversation appears there. That is the sync path.

## What is not automated

Nothing tells you a new version exists, and nothing checks that your images, chart and configuration are all at the same version. No backup of your database is taken before an upgrade, and since migrations only go forward there is no automated schema rollback. New configuration settings are not reported to you either, so compare your configuration against the example configuration after each upgrade. The bundled Keycloak's state is not preserved across a container replacement.

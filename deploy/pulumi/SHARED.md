# Shared Preview Stack Architecture

PR preview environments used to create the entire stack per PR — VPC, NAT, ALB,
ECS cluster, EFS, Postgres, Keycloak, PowerSync, plus the actual app services
(backend / frontend / marketing). That hit the region's default AWS quota for NAT
gateways, EIPs, and VPCs at ~5 concurrent PRs, and burned ~$300–500/mo on fixed
costs (NATs + ALBs) before any compute.

This doc describes the split-stack architecture that fixes that. It is in place
today — see "Status" below for the entry points.

## Two stacks

### `previews-shared` (long-lived, one per environment)

Owns everything that doesn't change per PR:

- **Networking:** VPC, NAT, IGW, EIP, public + private subnets, security groups
- **Storage:** EFS file system + Postgres access point
- **Compute substrate:** ECS cluster + CloudWatch log group
- **Service discovery:** Cloud Map private DNS namespace (`thunderbolt.local`)
- **Edge:** ALB + HTTPS listener (no per-service target groups — those are per-PR)
- **Heavy backing services:** Postgres and Keycloak ECS Fargate services
  (each is ~1 vCPU, ~2 GB and stable across PR code changes). Keycloak stores
  its data in a `keycloak` database on the shared Postgres.
- **Shared secrets:** AI provider keys, Postgres admin password, PowerSync JWT
  signing secret, Keycloak admin password

Deployed and updated by a separate workflow (manual trigger + scheduled drift
check). State lives in Pulumi Cloud just like everything else.

### `preview-pr-<n>` (per PR)

Owns only what genuinely differs per PR:

- 4 ECS services + task definitions: backend, frontend, marketing, PowerSync
- 4 target groups (frontend, backend, marketing, powersync) bound to the shared ALB
- 4 host-header listener rules on the shared ALB
- 4 Cloudflare CNAMEs (`thunderbolt-pr-<n>`, `app-pr-<n>`, `api-pr-<n>`,
  `powersync-pr-<n>`) pointing at the shared ALB — `auth.shared.*` belongs to the
  shared stack
- Per-PR Secrets Manager entries: Better Auth secret, OIDC client secret, debug
  transcript upstream key, the Postgres role password, `DATABASE_URL`, PowerSync's
  storage URL and base64 JWT key
- A per-PR Postgres role and two databases it owns on the shared instance: the app
  DB and PowerSync's `<db>_ps_storage`, created with the `powersync` publication by
  the backend task's `db-init` container. `scripts/drop-preview-db.sh` stops
  PowerSync, drops its replication slot, both databases and the role on teardown.
- Per-PR Keycloak OIDC client in the shared `thunderbolt` realm

Reads shared infra via Pulumi `StackReference("previews-shared")`.

## Cost / quota impact

Per PR (rough us-east-1 numbers):

| Resource                      | Before          | After               | Per-PR savings                             |
| ----------------------------- | --------------- | ------------------- | ------------------------------------------ |
| NAT Gateway                   | 1 ($32/mo idle) | 0                   | $32/mo                                     |
| EIP                           | 1               | 0                   | $0 (free when attached) but unblocks quota |
| ALB                           | 1 ($22/mo idle) | 0 (shares listener) | $22/mo                                     |
| Fargate (postgres + keycloak) | 2 vCPU + 4 GB   | 0 (shared)          | $32–40/mo                                  |
| Secrets Manager (AI keys × 5) | 5 × $0.40/mo    | 0                   | $2/mo                                      |
| **Total**                     | —               | —                   | **~$88–96/mo per PR**                      |

Plus quota relief: VPC, EIP, and NAT default limits go from 5 PRs to N PRs without
a quota request.

## Trade-offs flagged

1. **Migration-touching PRs.** Per-PR Postgres database (one logical DB per PR)
   isolates Drizzle migrations. Schema changes don't bleed across PRs. PRs that
   change shared role/extension config need explicit review.
2. **Keycloak realm config changes.** The shared realm is owned by the shared
   stack. PRs that need realm-config changes either coordinate with shared-stack
   updates or fall back to the legacy monolithic path (see "Legacy escape hatch").
3. **PowerSync is per-PR.** One PowerSync instance replicates one database, so
   a shared instance can't serve per-PR databases. Each PR runs its own, built
   from the PR's commit, so sync-config changes are exercised by their preview.
4. **ALB target-group cap.** ALB caps at 100 TGs per LB. With 4 TGs per PR
   (frontend / backend / marketing / powersync — keycloak shared), that's ~25
   concurrent PRs per ALB. If we exceed, add a second shared ALB.
5. **Single point of failure.** If shared Postgres goes down, all PR previews
   are unavailable. Mitigation: snapshot/restore automation; a secondary region
   if needed.

## Legacy escape hatch

Per-PR stacks where `pulumi config get sharedStackName` returns nothing fall
through to the existing monolithic `createServices()` path. This keeps:

- the `dev` Pulumi stack working
- the `jkab-org/demo` Pulumi stack working
- enterprise customer stacks working
- per-PR stacks for PRs that _need_ an isolated Keycloak (set the
  config explicitly to opt out)

No PR preview takes this path any more, but `dev`, `jkab-org/demo`, and
enterprise customer stacks still do, so it stays.

## Status

Shipped — the split above is what runs today.

`index.ts` picks one of three shapes by stack name and config. `previews-shared` builds
the shared stack via `createSharedStack()` (`index.ts:45`, `src/shared.ts`); any stack with
a `sharedStackName` config value resolves that stack's outputs through a `StackReference`
and builds the slim per-PR stack (`index.ts:95`, `src/per-pr-stack.ts`); everything else
falls through to the monolithic `createServices()` path (`index.ts:150`).

The shared stack is deployed by `.github/workflows/previews-shared-deploy.yml` — manual
`workflow_dispatch`, plus a Monday 07:00 UTC `pulumi up` that doubles as the drift check
(it should be a no-op when nothing has drifted).

Every PR preview is on the shared model: `.github/workflows/preview-deploy.yml`'s `deploy` job passes
`shared_stack_name: previews-shared` unconditionally, and `stack-deploy.yml`'s `deploy` job turns that
input into `pulumi config set sharedStackName`. `dev`, `jkab-org/demo`, and enterprise
customer stacks remain on the monolithic path (see "Legacy escape hatch").

## Resolved design questions

**Per-PR database provisioning — a `db-init` container does it.** The backend task's
first container (`dbInitScript` in `src/per-pr-stack.ts`) runs `psql` as the superuser from a
digest-pinned `postgres:18-alpine` image, so the PR's own images never see that password. On
every task start it creates a role named after the database (`LOGIN REPLICATION`, nothing
more), the per-stack database and its PowerSync storage database (`<db>_ps_storage`), both
owned by that role, revokes `CONNECT` from `PUBLIC` on every database so only owners and
superusers connect (Keycloak connects as the superuser), and creates the `powersync`
publication, which needs a superuser. A database the superuser owns, left by a stack deployed
before per-preview roles, is dropped and recreated. The backend starts once it exits 0 and
applies migrations as the role, which therefore owns every table PowerSync replicates. The name comes
from the Pulumi stack name with every non-alphanumeric character replaced by `_`
(`preview-pr-846` → `preview_pr_846`, `dbNameFromStack`), and both URLs reach the task as
Secrets Manager entries. Teardown is `scripts/drop-preview-db.sh`, which `stack-deploy.yml`'s `destroy` job runs
before `pulumi destroy` for every preview destroy (PR close, hourly orphan cleanup,
manual): it stops the PR's PowerSync, then runs the `db-init` container with a command that
drops its replication slot, both databases and the role. As a
backstop the shared Postgres runs with `max_slot_wal_keep_size`, so a slot that escapes a
failed drop stops pinning WAL. The
alternatives considered were a Pulumi `command.local.Command` running `psql` through a
private bastion task, and a Pulumi-triggered Lambda; both add a component an init
container does not.

**Per-PR Keycloak OIDC client.** `src/per-pr-stack.ts:235` provisions
`thunderbolt-app-<stack>` in the shared `thunderbolt` realm through a `@pulumi/keycloak`
provider authenticated with the shared stack's admin credentials, with exact-match
redirect and origin URIs. It has to be per-PR: Keycloak only honors `*` as a trailing path
wildcard in `validRedirectUris` and has no hostname wildcards, so an `api-pr-*.…` redirect
URI on one shared client never matches a real PR. Keycloak keeps its data in the shared
Postgres, so these clients survive a Keycloak restart, and `stack-deploy.yml` runs
`pulumi up` with `refresh: true`, so a client missing for any other reason is recreated
on the PR's next deploy.

**Per-PR PowerSync.** One PowerSync instance replicates one database, so each PR runs
its own, built from the PR's commit and replicating its `preview_pr_<n>` database. Every
PR's backend and PowerSync share one JWT secret (`shared.powersyncJwtSecretArn`).

## Still open

- Snapshot/restore automation for the shared Postgres (trade-off 5 above).

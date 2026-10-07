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
- **Heavy backing services:** Postgres, Keycloak, PowerSync ECS Fargate services
  (each is ~1 vCPU, ~2 GB and stable across PR code changes)
- **Shared secrets:** AI provider keys, Postgres admin password, PowerSync JWT
  signing secret, Keycloak admin password

Deployed and updated by a separate workflow (manual trigger + scheduled drift
check). State lives in Pulumi Cloud just like everything else.

### `preview-pr-<n>` (per PR)

Owns only what genuinely differs per PR:

- 3 ECS services + task definitions: backend, frontend, marketing
- 3 target groups (frontend, backend, marketing) bound to the shared ALB
- 3 host-header listener rules on the shared ALB
- 3 Cloudflare CNAMEs (`thunderbolt-pr-<n>`, `app-pr-<n>`, `api-pr-<n>`) pointing at the
  shared ALB — `auth.shared.*` and `powersync.shared.*` belong to the shared stack
- Per-PR Secrets Manager entries: Better Auth secret, OIDC client secret, debug
  transcript upstream key, `DATABASE_URL`, `POSTGRES_ADMIN_URL`
- Per-PR Postgres database (provisioned at backend startup against shared instance)
- Per-PR Keycloak OIDC client in the shared `thunderbolt` realm

Reads shared infra via Pulumi `StackReference("previews-shared")`.

## Cost / quota impact

Per PR (rough us-east-1 numbers):

| Resource                                  | Before          | After               | Per-PR savings                             |
| ----------------------------------------- | --------------- | ------------------- | ------------------------------------------ |
| NAT Gateway                               | 1 ($32/mo idle) | 0                   | $32/mo                                     |
| EIP                                       | 1               | 0                   | $0 (free when attached) but unblocks quota |
| ALB                                       | 1 ($22/mo idle) | 0 (shares listener) | $22/mo                                     |
| Fargate (postgres + keycloak + powersync) | 2.5 vCPU + 5 GB | 0 (shared)          | $40–50/mo                                  |
| Secrets Manager (AI keys × 5)             | 5 × $0.40/mo    | 0                   | $2/mo                                      |
| **Total**                                 | —               | —                   | **~$95–105/mo per PR**                     |

Plus quota relief: VPC, EIP, and NAT default limits go from 5 PRs to N PRs without
a quota request.

## Trade-offs flagged

1. **Migration-touching PRs.** Per-PR Postgres database (one logical DB per PR)
   isolates Drizzle migrations. Schema changes don't bleed across PRs. PRs that
   change shared role/extension config need explicit review.
2. **Keycloak realm config changes.** The shared realm is owned by the shared
   stack. PRs that need realm-config changes either coordinate with shared-stack
   updates or fall back to the legacy monolithic path (see "Legacy escape hatch").
3. **PowerSync sync-rule changes.** Same shape: shared instance, shared rules.
   PRs that change sync rules use the legacy path until per-PR PowerSync tenants
   land.
4. **ALB target-group cap.** ALB caps at 100 TGs per LB. With 3 TGs per PR
   (frontend / backend / marketing — keycloak + powersync shared), that's ~33
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
- per-PR stacks for PRs that _need_ an isolated Keycloak / PowerSync (set the
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

Every PR preview is on the shared model: `.github/workflows/preview-deploy.yml:164` passes
`shared_stack_name: previews-shared` unconditionally, and `stack-deploy.yml:228` turns that
input into `pulumi config set sharedStackName`. `dev`, `jkab-org/demo`, and enterprise
customer stacks remain on the monolithic path (see "Legacy escape hatch").

## Resolved design questions

**Per-PR database provisioning — the backend entrypoint does it.** When
`POSTGRES_ADMIN_URL` is set, `deploy/docker/backend-entrypoint.sh:45-65` connects as the
admin on the default database, creates the per-stack database if it does not already
exist, and only then runs `drizzle-kit migrate` against `DATABASE_URL`. The name comes
from the Pulumi stack name with every non-alphanumeric character replaced by `_`
(`preview-pr-846` → `preview_pr_846`, `src/per-pr-stack.ts:67`; the JSDoc a line above it
still shows an older `pr_846` shape), and both URLs reach the task as Secrets Manager
entries. This couples the database lifecycle to the backend's — destroying a PR stack
leaves its logical database behind until the shared Postgres is rebuilt — which is the
price of not needing extra infrastructure. The
alternatives considered were a Pulumi `command.local.Command` running `psql` through a
private bastion task, and a Pulumi-triggered Lambda; both add a component the entrypoint
does not.

**Per-PR Keycloak OIDC client.** `src/per-pr-stack.ts:235` provisions
`thunderbolt-app-<stack>` in the shared `thunderbolt` realm through a `@pulumi/keycloak`
provider authenticated with the shared stack's admin credentials, with exact-match
redirect and origin URIs. It has to be per-PR: Keycloak only honors `*` as a trailing path
wildcard in `validRedirectUris` and has no hostname wildcards, so an `api-pr-*.…` redirect
URI on one shared client never matches a real PR.

**PowerSync JWT issuance needs no per-PR config.** Per-PR backends sign with the shared
PowerSync JWT secret (`src/per-pr-stack.ts:401` reads `shared.powersyncJwtSecretArn`) and
PowerSync verifies the signature regardless of which PR issued it.

## Still open

- Per-PR PowerSync tenants, for PRs that change sync rules (trade-off 3 above).
- Snapshot/restore automation for the shared Postgres (trade-off 5 above).
- Replication of the per-PR databases. The shared PowerSync has one replication source
  — `PS_PG_URI` points at the shared instance's `postgres` database
  (`src/shared.ts:480`) — while each PR's backend writes to its own `preview_pr_<n>`
  database, so per-PR rows never reach PowerSync.

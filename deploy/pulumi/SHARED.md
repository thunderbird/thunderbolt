# Shared Preview Stack Architecture

PR preview environments today create the entire stack per PR — VPC, NAT, ALB,
ECS cluster, EFS, Postgres, Keycloak, PowerSync, plus the actual app services
(backend / frontend / marketing). At ~5 concurrent PRs we're at default AWS
quota for NAT gateways, EIPs, and VPCs in the region, and burning ~$300–500/mo
on fixed costs (NATs + ALBs) before any compute.

This doc describes the split-stack architecture that fixes that.

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
- 5 Cloudflare CNAMEs (`marketing-pr-<n>`, `app-pr-<n>`, `api-pr-<n>`, `auth-pr-<n>`, `powersync-pr-<n>`)
- Per-PR Secrets Manager entries: `BETTER_AUTH_SECRET`, `OIDC_CLIENT_SECRET`
- Per-PR Postgres database (provisioned at backend startup against shared instance)
- Per-PR Keycloak OIDC client in the shared `thunderbolt` realm

Reads shared infra via Pulumi `StackReference("previews-shared")`.

## Cost / quota impact

Per PR (rough us-east-1 numbers):

| Resource | Before | After | Per-PR savings |
| --- | --- | --- | --- |
| NAT Gateway | 1 ($32/mo idle) | 0 | $32/mo |
| EIP | 1 | 0 | $0 (free when attached) but unblocks quota |
| ALB | 1 ($22/mo idle) | 0 (shares listener) | $22/mo |
| Fargate (postgres + keycloak + powersync) | 2.5 vCPU + 5 GB | 0 (shared) | $40–50/mo |
| Secrets Manager (AI keys × 5) | 5 × $0.40/mo | 0 | $2/mo |
| **Total** | — | — | **~$95–105/mo per PR** |

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
   PRs that change sync rules use the legacy path until Phase 3 (per-PR PowerSync
   tenants) lands.
4. **ALB target-group cap.** ALB caps at 100 TGs per LB. With 3 TGs per PR
   (frontend / backend / marketing — keycloak + powersync shared), that's ~33
   concurrent PRs per ALB. If we exceed, add a second shared ALB.
5. **Single point of failure.** If shared Postgres goes down, all PR previews
   are unavailable. Mitigation: snapshot/restore automation; secondary region
   (Phase 4 if needed).

## Legacy escape hatch

Per-PR stacks where `pulumi config get sharedStackName` returns nothing fall
through to the existing monolithic `createServices()` path. This keeps:

- the `dev` Pulumi stack working
- the `jkab-org/demo` Pulumi stack working
- enterprise customer stacks working
- per-PR stacks for PRs that *need* an isolated Keycloak / PowerSync (set the
  config explicitly to opt out)

We can deprecate the monolithic path entirely once all preview-pr stacks are
on the shared model.

## Phasing

- **Phase 1 (this commit):** scaffolding — `src/shared.ts`, `src/per-pr-stack.ts`,
  branching in `index.ts`. Both new paths are stubbed (throw) so nothing
  accidentally activates them. Existing stacks unaffected.
- **Phase 2:** move VPC + EFS + cluster + namespace + ALB into `createSharedStack()`.
  Move `createServices()`'s postgres / keycloak / powersync blocks into shared too.
  Define complete `SharedStackOutputs` shape.
- **Phase 3:** implement `createPerPrStack()` — backend / frontend / marketing
  services, target groups, host-header rules, Cloudflare CNAMEs. Per-PR DB +
  Keycloak client provisioning via Pulumi `Command` + `@pulumi/keycloak` providers.
- **Phase 4:** workflow updates — new `previews-shared-deploy.yml`, update
  `preview-deploy.yml` to consume `sharedStackName` from a workflow var.
- **Phase 5:** migrate live preview-pr stacks: destroy each, redeploy on shared
  model, validate, repeat. `dev` and `jkab-org/demo` stay on monolithic.

## Open questions / TODOs

- **Per-PR DB provisioning mechanism.** Three options:
  1. Backend's entrypoint runs `CREATE DATABASE pr_<n> IF NOT EXISTS` before
     drizzle-kit migrate, using admin creds it can read from Secrets Manager.
     Simplest; couples DB lifecycle to backend lifecycle (DB orphaned on stack
     destroy unless backend cleans up — acceptable, gets cleaned on shared-stack
     rebuild).
  2. Pulumi `command.local.Command` runs `psql` via SSM Session Manager against
     a private bastion task in the shared cluster. Cleaner separation; needs
     bastion infra.
  3. Lambda triggered by Pulumi.
  Phase 3 will pick option 1 unless we hit issues.
- **Per-PR Keycloak OIDC client.** Use `@pulumi/keycloak` provider against the
  shared Keycloak admin API. Provider needs admin creds — shared stack exports
  them. Resource: `keycloak.openid.Client`.
- **PowerSync wildcard JWT issuer.** Per-PR backends sign JWTs with the shared
  PowerSync JWT secret. PowerSync verifies signatures regardless of which PR
  issued them. ✓ no per-PR config needed.
- **Drift detection** on the shared stack. CI scheduled job that runs
  `pulumi preview` and alerts if anything drifts.

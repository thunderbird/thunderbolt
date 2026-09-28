# CI and Preview Environments

## What runs on a pull request

| Workflow                  | Trigger                                   | Failure mode             | Reproduce locally               |
| ------------------------- | ----------------------------------------- | ------------------------ | ------------------------------- |
| `ci.yml`                  | PR (any base branch) + push to `main`     | Red check                | See the job table below         |
| `e2e.yml`                 | PR + push to `main`                       | Red check                | `bun run e2e`                   |
| `security.yml`            | PR + push to `main`                       | Red check                | n/a                             |
| `lint-pr-title.yml`       | PR opened / edited / synchronized         | Red check                | n/a                             |
| `pr-metrics.yml`          | PR                                        | Advisory comment         | `bun run build && bun run size` |
| `thunder-deep-review.yml` | PR, same-repo, non-draft, non-Dependabot  | Advisory comment         | n/a                             |
| `preview-deploy.yml`      | PR against `main` (+ `workflow_dispatch`) | No preview comment       | n/a                             |
| `preview-destroy.yml`     | PR closed (+ `workflow_dispatch`)         | Cleanup cron picks it up | n/a                             |

Also part of the same machinery:

| Workflow                      | Trigger                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `preview-cleanup.yml`         | Hourly cron                                                       |
| `previews-shared-deploy.yml`  | Manual, plus Mondays 07:00 UTC                                    |
| `nightly-images.yml`          | 05:00 UTC                                                         |
| `images-publish.yml`          | Push to `main` under a path filter, or called by `preview-deploy` |
| `evals.yml`, `test-build.yml` | Manual only                                                       |

Release workflows: [RELEASE.md](../../../RELEASE.md).

## The `ci.yml` jobs

| Job             | Runs when                                                                      | What it does                                                         |
| --------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `typescript`    | Always                                                                         | `tsc --noEmit`, `bun run lint`, `bun run test:5x`                    |
| `backend`       | Always                                                                         | Backend type-check, lint, tests (5x) plus the segregated WS suite    |
| `localization`  | `src/**`, `shared/**`, i18n/build config, `backend/src/emails/**`, `bun.lock`  | `bun run i18n:check`, a catalog-compiling build, the macro tripwire  |
| `agent-core`    | `shared/agent-core/**`, `vite.config.ts`, `package.json`, `bun.lock`, `ci.yml` | `bun run test:agent-core:5x` plus the Chromium/WebKit browser check  |
| `cli`           | `cli/**`, `shared/agent-core/**` and the shared contracts the CLI imports      | CLI type-check, tests (5x), build, and an artifact smoke test        |
| `wasm-artifact` | `src/acp/iroh/pkg/**` or `crates/thunderbolt-acp-client/` sources              | Staleness gate plus `CHECKSUMS.txt` verification                     |
| `rust`          | `src-tauri/**` Rust sources/manifests or `crates/**`                           | The RUSTSEC tripwire, then `cargo build`/`clippy -D warnings`/`test` |

Only `typescript` and `backend` run on every PR; the rest are gated by `detect-changes`
(`dorny/paths-filter`), so **"CI passed" can mean "your job never ran"**. `agent-core` runs
on `macos-latest`: WebKit's Linux build lacks the OPFS storage API.

### Not in CI: Prettier and MPL license headers

Both run only in the `husky` pre-commit hook via
[`.lintstagedrc.json`](../../../.lintstagedrc.json) (`bun scripts/license-headers.ts`,
`make format`), so `--no-verify` can land unformatted code. `bun run check` runs the full
local set (type-check, lint, format-check, license-check).

## Every test job runs five times

| Suite        | CI command                                    | Per-test timeout in CI         |
| ------------ | --------------------------------------------- | ------------------------------ |
| Frontend     | `bun run test:5x`                             | Disabled (`--timeout 3600000`) |
| Backend      | `bun test … --randomize --rerun-each 5`       | Disabled (`--timeout 3600000`) |
| `agent-core` | `bun run test:agent-core:5x`                  | 5s                             |
| CLI          | `cd cli && bun run test:5x`                   | 5s                             |
| Backend WS   | `bun run test:backend:ws` (once, ≤5 attempts) | Disabled (`--timeout 3600000`) |

- `bun run test` is not what CI runs: `--randomize` plus the 5x repeat catches
  order-dependent and one-in-fifty failures. Reproduce with the `:5x` script.
- The disabled timeout (Bun's `--timeout 0` hangs async tests) leans on step and job caps:
  10 minutes on the backend test step, 15 or 20 on the jobs. Local `test` and
  `test:backend` keep the 5-second timeout.

### Why the WebSocket suite is excluded

`src/proxy/ws-e2e.test.ts` and `src/haystack/routes.test.ts` run once, in a retry action
with up to five attempts: they wait on same-process WebSocket close and message events
that Bun drops or delays under load. Five consecutive non-zero attempts still red the
build.

## The Bun versions differ on purpose

| Bun version | Jobs                                                   |
| ----------- | ------------------------------------------------------ |
| 1.3.14      | `typescript`, `localization`, `agent-core`, `cli`, e2e |
| 1.3.13      | `backend`, `pr-metrics.yml`                            |

Not drift: on the backend job 1.3.14 caused multi-minute hangs inside PGlite's WASM that
the per-test timeout could not interrupt, never seen on 1.3.13. Rationale sits by the pin
in [`ci.yml`](../../../.github/workflows/ci.yml).

## Gates that surprise people

**Stale wasm artifact.** The iroh ACP client ships prebuilt at `src/acp/iroh/pkg` so the
web build needs no wasm toolchain; touching the crate source without committing a
regenerated `pkg/` fails `wasm-artifact` with a fix instruction, and the committed files
are verified against `CHECKSUMS.txt`. Rebuild with
`crates/thunderbolt-acp-client/build.sh` (`--verify` reproduces bit-identically on the
pinned toolchain).

**Untransformed Lingui macros.** A macro that escapes the Babel transform renders literal
`<Trans>` instead of failing the build, so the `localization` job greps the bundle for the
stub's error text ("outside the context of compilation"). It fails if `dist/assets` is
missing (a moved `outDir` would make it a silent pass), and runs `bun run i18n:check` over
the frontend and backend email catalogs ([AGENTS.md](../../../AGENTS.md)).

**The glib unsoundness tripwire.** The `rust` job runs
`scripts/check-glib-variantstriter.sh` first: RUSTSEC-2024-0429 is accepted only because
`glib::VariantStrIter` has zero callers in the Linux build graph, and the script reds the
job if a dependency gains one.

**Shared CLI dependency skew.** `cli/` has its own lockfile but imports `shared/agent-core`,
which resolves from the repo root. The `cli` job asserts `@earendil-works/pi-ai` and
`openai` match across both trees.

**CI's own scripts are unit-tested by the frontend suite.**
`.github/scripts/post-pr-metrics.test.js`, `post-eval-results.test.ts` and
`review-orchestrator.test.mjs` are listed in the `test` and `test:5x` scripts, so editing a
CI script can break `bun run test`.

**PR titles.** `lint-pr-title.yml` accepts the legacy `THU-123: …` form or Conventional
Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`, `build`,
`style`); scopes are optional.

**Semgrep.** Diff-aware against the base SHA on PRs, full scan on pushes to `main`; any
report uploads as SARIF. The PR comment is skipped on fork PRs (read-only token, the
comments API would 403), and the whole job is skipped for Dependabot.

**e2e sharding.** Two Playwright shards each upload a blob report; `e2e-report` merges
them into one HTML artifact (14-day retention). Failure screenshots upload per shard; a
shard failure does not cancel its sibling.

## The two bots that comment

### `pr-metrics.yml`

Posts one updating comment: changed lines (excluding tests, migrations and lockfiles),
gzipped bundle size, test coverage, Lighthouse scores.

- The bundle number is the **entry chunk only**: both `size-limit` entries in
  `package.json` are measured, but the workflow reads `.[0].size`, the JS entry chunk
  (FCP). Reproduce with `bun run build && bun run size`.
- Nothing is enforced: neither entry declares a `limit`, so the mechanism is the comment's
  delta colouring (red above +50 KB, yellow above +10 KB) on the entry chunk that
  [AGENTS.md's code-splitting rules](../../../AGENTS.md) protect.
- The baseline is a cache entry written on every push to `main` (`pr-metrics-main-<sha>`),
  with a `pr-metrics-main-` prefix fallback, so a base commit with no entry is compared
  against an earlier `main` build.
- Lighthouse is advisory: [`lighthouserc.js`](../../../lighthouserc.js) sets every assertion
  to `warn` and reports the median of three runs. It scores the **Render** preview, not the
  Pulumi stack.

### `thunder-deep-review.yml`

Runs the `thunder-deep-review` skill read-only and posts an inline review.

- Never approves, requests changes, or merges.
- Fails soft: an unrecoverable error logs and exits 0 without posting, since a missing
  review beats a duplicate or truncated one. A model step returning no structured output
  reds the job instead of recording a fake clean review.
- Hard-gated to same-repo, non-draft, non-Dependabot PRs: fork code must never run with
  the API key.
- Sleeps 60 seconds so rapid pushes cancel at zero model cost, sequences behind the
  external review bots, and skips findings they already reported.
- Escalates to a deeper fan-out at ≥600 changed lines, ≥40 files, or the `review:deep`
  label.
- All GitHub I/O is deterministic code in `.github/scripts/review-orchestrator.mjs`; the
  model step only emits structured findings.

## Where your PR gets deployed

A PR against `main` gets two previews, and they are not equivalent.

| Preview                 | URL                                                                           | What it is                                                                                      | Use it for                                                         |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Render (auto)           | `https://thunderbolt-pr-<n>.onrender.com`                                     | The web app, deployed by Render                                                                 | Quick UI checks; it is what Lighthouse scores                      |
| Pulumi stack on Fargate | `app-pr-<n>.preview.thunderbolt.io` (plus `api-pr-<n>`, `thunderbolt-pr-<n>`) | The PR's own backend, frontend and marketing services, with their own logical Postgres database | Anything touching sync, SSO, migrations, or cross-device behaviour |

Fork PRs get the Pulumi preview only after a maintainer approves the run (see
[Preview lifecycle](#preview-lifecycle)).

### Render preview

Configured in the Render dashboard, not in this repo. Two code paths know about it:

- `deploy/docker/backend-entrypoint.sh` appends `RENDER_EXTERNAL_URL` to `CORS_ORIGINS`
  when `IS_PULL_REQUEST=true`.
- `isPrPreview()` in [src/lib/platform.ts](../../../src/lib/platform.ts) matches
  `thunderbolt-pr-<n>.onrender.com`, and
  [src/contexts/sign-in-modal-context.tsx](../../../src/contexts/sign-in-modal-context.tsx)
  bypasses the waitlist there. Test waitlist flows on the Pulumi stack instead.

Render also hosts the production `powersync` service, which does **not** auto-deploy:
after a sync-rule change merges and `images-publish.yml` publishes a new
`thunderbolt-powersync` image, roll it by hand
([two-PR sequence](../architecture/powersync-account-devices.md)).

### Pulumi preview

Publishes the PR's images to GHCR under a `pr-<n>-<sha>` tag, deploys the `preview-pr-<n>`
stack, and comments five URLs (marketing, app, api, auth, powersync). Only the first three
are per-PR: [per-pr-stack.ts](../../../deploy/pulumi/src/per-pr-stack.ts) creates ALB host
rules and Cloudflare CNAMEs for those, while Keycloak and PowerSync belong to the shared
stack on `*.shared.preview.thunderbolt.io`. Sign in to the shared Keycloak realm with
`demo@thunderbolt.io` / `demo`.

## Preview lifecycle

### The shared stack must exist first

Per-PR stacks read the VPC, ALB, Postgres, Keycloak and PowerSync from the long-lived
`previews-shared` stack via a Pulumi `StackReference`, so **no per-PR deploy succeeds
without it**. Only `previews-shared-deploy.yml` creates or updates it; the weekly run
doubles as a drift check.

Each PR gets its own OIDC client in the shared Keycloak realm, so a PR needing different
realm config or different PowerSync sync rules must fall back to a monolithic deploy with
`shared_stack_name` empty ([SHARED.md](../../../deploy/pulumi/SHARED.md)).

### Fork PRs need approval on every push

They deploy through `pull_request_target` behind the `fork-preview-approval` environment,
so a maintainer approves **every push**, not every PR; that is why a fork preview sits
pending. Under that trigger the workflow file and the Pulumi program come from `main`, so
a fork can change image contents but never the infrastructure code.

### Teardown: on close, hourly, and by hand

`preview-destroy.yml` fires on PR close. `scripts/drop-preview-db.sh` runs before
`pulumi destroy` because it needs the per-stack secrets and backend task definition the
stack owns; destroy runs even if the drop fails, so a flaky drop cannot orphan an ALB and
leak cost.

Pulumi does not remove the logical database that `deploy/docker/backend-entrypoint.sh`
creates per PR at backend startup on the shared Postgres instance (when
`POSTGRES_ADMIN_URL` is set). Left behind, its `__drizzle_migrations` hashes leak into the
next deploy of the same PR number and `drizzle-kit` fails once a migration has been
re-edited.

`preview-cleanup.yml` is the hourly safety net for a failed teardown, a PR closed out of
band, or an open PR idle beyond `max_age_days` (default 3).

- It enumerates only stacks matching `^preview-pr-[0-9]+$` in this Pulumi project, so it
  cannot reach a production stack.
- The **`preview:persist`** label keeps a stack alive past those rules, for a demo or QA
  environment pinned to a PR.
- `workflow_dispatch` takes a `dry_run` input that lists what would be destroyed.

Both accept a `pr_number` via `workflow_dispatch`, to redeploy after a failed run or force
a teardown.

## Scripts the pipeline depends on

| Script                                    | Invoked by                                           | Notes                                                                 |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `scripts/check-glib-variantstriter.sh`    | `ci.yml` `rust` job                                  | RUSTSEC-2024-0429 tripwire; runs before the build because it is cheap |
| `scripts/agent-core-browser-check.ts`     | `bun run test:agent-core:browser` (`agent-core` job) | Chromium + WebKit check of the production agent chunk                 |
| `crates/thunderbolt-acp-client/build.sh`  | You, by hand                                         | Regenerates `src/acp/iroh/pkg`; `--verify` reproduces the checksums   |
| `scripts/drop-preview-db.sh`              | `preview-destroy.yml`                                | Drops the per-PR logical database before `pulumi destroy`; idempotent |
| `.github/scripts/review-orchestrator.mjs` | `thunder-deep-review.yml`                            | All GitHub I/O for the review bot; unit-tested by `bun run test`      |
| `.github/scripts/post-pr-metrics.cjs`     | `pr-metrics.yml`                                     | Renders the metrics comment; unit-tested by `bun run test`            |
| `.github/scripts/post-eval-results.ts`    | `evals.yml`                                          | Unit-tested by `bun run test`                                         |
| `scripts/lingui-macro-bun-shim.ts`        | `--preload` on every `eval*` script                  | See below                                                             |

Bun has no Babel pass, so a Lingui macro imported under plain `bun run` resolves to a stub
that throws, and the eval CLIs reach UI modules transitively. Every `eval*` script in
`package.json` therefore runs as `bun --preload ./scripts/lingui-macro-bun-shim.ts …`,
which is how `evals.yml` invokes them. A new Bun entry point importing app code needs the
same preload; Bun tests get it from `src/testing-library.ts`.

## See also

- [Testing](testing.md): what each test command covers
- [backend/docs/testing.md](../../../backend/docs/testing.md): the backend suite and its
  CI-only differences
- [deploy/README.md §4](../../../deploy/README.md): deploy inputs, secrets, enterprise path
- [deploy/pulumi/SHARED.md](../../../deploy/pulumi/SHARED.md): shared/per-PR stack architecture
- [RELEASE.md](../../../RELEASE.md): release, version-bump and platform build workflows

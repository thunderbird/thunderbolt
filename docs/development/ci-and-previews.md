# CI and Preview Environments

Opening a pull request starts seven workflows — four that can turn a check red, two that
leave an advisory comment, and one that deploys a disposable environment — plus a second
preview on an unrelated provider. This page maps that out: what each check actually verifies, how to
reproduce it locally, and which preview URL answers which question.

Infrastructure detail lives elsewhere and is not repeated here — see
[deploy/README.md §4](../../deploy/README.md) for the deploy workflows' inputs and secrets,
and [deploy/pulumi/SHARED.md](../../deploy/pulumi/SHARED.md) for the shared/per-PR stack
architecture.

## What runs on a pull request

| Workflow                  | Trigger                                   | Failure mode             | Reproduce locally               |
| ------------------------- | ----------------------------------------- | ------------------------ | ------------------------------- |
| `ci.yml`                  | PR (any base branch) + push to `main`     | Red check                | See the job table below         |
| `e2e.yml`                 | PR + push to `main`                       | Red check                | `bun run e2e`                   |
| `security.yml`            | PR + push to `main`                       | Red check                | —                               |
| `lint-pr-title.yml`       | PR opened / edited / synchronized         | Red check                | —                               |
| `pr-metrics.yml`          | PR                                        | Advisory comment         | `bun run build && bun run size` |
| `thunder-deep-review.yml` | PR, same-repo, non-draft, non-Dependabot  | Advisory comment         | —                               |
| `preview-deploy.yml`      | PR against `main` (+ `workflow_dispatch`) | No preview comment       | —                               |
| `preview-destroy.yml`     | PR closed (+ `workflow_dispatch`)         | Cleanup cron picks it up | —                               |

Not PR-triggered, but part of the same machinery: `preview-cleanup.yml` (hourly cron),
`previews-shared-deploy.yml` (manual plus Mondays 07:00 UTC), `nightly-images.yml`
(05:00 UTC), `images-publish.yml` (push to `main` under a path filter, or called by
`preview-deploy.yml`), `evals.yml` and `test-build.yml` (manual only). The release
workflows are documented in [RELEASE.md](../../RELEASE.md).

## The `ci.yml` jobs

Only `typescript` and `backend` run on every PR. The other five are gated by the
`detect-changes` job's `dorny/paths-filter` step, so **"CI passed" can mean "your job never
ran"** — and equally, a one-line change under `crates/` can light up jobs you have never
seen before.

| Job             | Runs when                                                                      | What it does                                                         |
| --------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `typescript`    | Always                                                                         | `tsc --noEmit`, `bun run lint`, `bun run test:5x`                    |
| `backend`       | Always                                                                         | Backend type-check, lint, tests (5x) plus the segregated WS suite    |
| `localization`  | `src/**`, `shared/**`, i18n/build config, `backend/src/emails/**`, `bun.lock`  | `bun run i18n:check`, a catalog-compiling build, the macro tripwire  |
| `agent-core`    | `shared/agent-core/**`, `vite.config.ts`, `package.json`, `bun.lock`, `ci.yml` | `bun run test:agent-core:5x` plus the Chromium/WebKit browser check  |
| `cli`           | `cli/**`, `shared/agent-core/**` and the shared contracts the CLI imports      | CLI type-check, tests (5x), build, and an artifact smoke test        |
| `wasm-artifact` | `src/acp/iroh/pkg/**` or `crates/thunderbolt-acp-client/` sources              | Staleness gate plus `CHECKSUMS.txt` verification                     |
| `rust`          | `src-tauri/**` Rust sources/manifests or `crates/**`                           | The RUSTSEC tripwire, then `cargo build`/`clippy -D warnings`/`test` |

`agent-core` runs on `macos-latest` rather than Linux: WebKit's Linux build lacks the
storage API the OPFS persistence check needs.

Two checks you might expect in CI are not there: Prettier formatting and MPL license
headers. Both run in the `husky` pre-commit hook through
[`.lintstagedrc.json`](../../.lintstagedrc.json) (`bun scripts/license-headers.ts` plus
`make format`), so a commit made with `--no-verify` can land unformatted without CI
noticing. `bun run check` runs the full local set (type-check, lint, format-check,
license-check).

## Every test job runs five times

`bun run test` is not what CI runs. It runs `bun run test:5x`,
`bun run test:agent-core:5x`, `cd cli && bun run test:5x`, and (for the backend)
`bun test … --randomize --rerun-each 5`. Combined with `--randomize`, that is a stability
contract, not a performance accident: a test that only fails on a particular execution
order, or one in fifty runs, fails CI rather than someone else's PR a week later. A single
green local run tells you very little — reproduce a CI-only failure with the `:5x` script,
not the plain one.

The frontend and backend runs also drop the per-test timeout (`--timeout 3600000`,
effectively disabled — Bun's `--timeout 0` hangs async tests) and rely on the step and job
caps instead — 10 minutes on the backend test step, a 15- or 20-minute cap on the jobs — so
tests that are merely slow under runner contention do not fail spuriously. The local `test`
and `test:backend` scripts keep the 5-second timeout, and so do `test:agent-core:5x` and the
CLI's `test:5x` in CI.

The backend's WebSocket suite inverts the policy. `src/proxy/ws-e2e.test.ts` and
`src/haystack/routes.test.ts` are excluded from the 5x run and executed **once** by
`bun run test:backend:ws`, wrapped in a retry action with up to five attempts. They wait on
same-process WebSocket close and message events that Bun drops or delays under load; the
systematic causes were fixed, and the residual is irreducible. Rerunning them five times
multiplied the exposure instead of proving anything, while five consecutive non-zero
attempts still red the build. See
[backend/docs/testing.md](../../backend/docs/testing.md) for how the backend job differs
from a local run in other respects.

## The Bun versions differ on purpose

The `typescript`, `localization`, `agent-core`, `cli` and e2e jobs pin Bun **1.3.14**. The
`backend` job and `pr-metrics.yml` pin **1.3.13**. This is not drift: on the backend job,
1.3.14 correlated with hard hangs inside PGlite's WASM that the per-test timeout could not
even interrupt (multi-minute stalls), never observed on 1.3.13. Unifying the versions
reintroduces that. The rationale is recorded next to the pin in
[`ci.yml`](../../.github/workflows/ci.yml).

## Gates that surprise people

**Stale wasm artifact.** The iroh ACP client ships as a prebuilt wasm bundle at
`src/acp/iroh/pkg` so the web build needs no wasm toolchain. Touching the crate source
without committing a regenerated `pkg/` in the same PR fails `wasm-artifact` with a fix
instruction; the committed files are also verified against `CHECKSUMS.txt`. Rebuild with
`crates/thunderbolt-acp-client/build.sh` (`--verify` reproduces bit-identically on the
pinned toolchain).

**Untransformed Lingui macros.** A macro that escapes the Babel transform does not break
the build — it renders literal `<Trans>` in the DOM. The `localization` job greps the built
bundle for the runtime stub's error text ("outside the context of compilation") so that
failure mode reds CI, and fails outright if `dist/assets` is missing, because a moved
`outDir` would otherwise turn the tripwire into a permanent silent pass. The same job runs
`bun run i18n:check`, which gates both the frontend and the backend email catalogs. See the
Localization section of [AGENTS.md](../../AGENTS.md) for the rules behind it.

**The glib unsoundness tripwire.** The `rust` job runs
`scripts/check-glib-variantstriter.sh` before building. RUSTSEC-2024-0429 is accepted only
because `glib::VariantStrIter` has zero callers anywhere in the Linux build graph; the
script locks that invariant and reds the job if any dependency gains one.

**Shared CLI dependency skew.** `cli/` has its own lockfile but imports `shared/agent-core`,
which resolves its dependencies from the repo root. The `cli` job asserts that
`@earendil-works/pi-ai` and `openai` are at identical versions in both trees.

**CI's own scripts are unit-tested by the frontend suite.**
`.github/scripts/post-pr-metrics.test.js`, `post-eval-results.test.ts` and
`review-orchestrator.test.mjs` are listed explicitly in the `test` and `test:5x` scripts, so
editing a CI script can break `bun run test`.

**PR titles.** `lint-pr-title.yml` accepts either the legacy `THU-123: …` form or
Conventional Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`,
`build`, `style`); scopes are optional.

**Semgrep.** PR runs are diff-aware against the base SHA; pushes to `main` scan everything.
Whenever the scan produces a report, it uploads as SARIF. The convenience PR comment is
skipped on fork PRs, where the `pull_request` token is read-only and the comments API would
403, and the whole job is skipped for Dependabot.

**e2e sharding.** Playwright runs across two shards that each upload a blob report; a
follow-on `e2e-report` job merges them into one HTML artifact (14-day retention).
Failure screenshots upload per shard. A shard failure does not cancel its sibling.

## The two bots that comment

**`pr-metrics.yml`** posts a single updating comment with changed line count (excluding
tests, migrations and lockfiles), gzipped bundle size, test coverage, and Lighthouse
scores. Two things are worth knowing before you read it:

- The bundle number is the **entry chunk only**, not the whole bundle. Both `size-limit`
  entries in `package.json` are measured, but the workflow reads `.[0].size` — the
  `JS entry chunk (FCP)` entry. Neither entry declares a `limit`, so nothing is enforced:
  the comment colours the delta (red above +50 KB, yellow above +10 KB) and that is the
  whole mechanism. The entry chunk is what
  [AGENTS.md's route-level code-splitting rules](../../AGENTS.md) exist to protect;
  reproduce the number with `bun run build && bun run size`.
- The baseline comes from a cache entry written on every push to `main`
  (`pr-metrics-main-<sha>`). The restore step falls back to a `pr-metrics-main-` prefix
  match, so on a PR whose base commit has no entry the delta is measured against some
  earlier `main` build rather than yours.

Lighthouse is advisory by construction: [`lighthouserc.js`](../../lighthouserc.js) sets
every assertion to `warn`, takes three runs, and the workflow reports the median. It scores
the **Render** preview (below), not the Pulumi stack.

**`thunder-deep-review.yml`** runs the `thunder-deep-review` skill read-only and posts an
inline review. It never approves, requests changes, or merges, and the orchestrator
fails soft: on any unrecoverable error it logs and exits 0 without posting, because a
missing review is acceptable where a duplicate or truncated one is not. The exception is a
model step that returns no structured output at all — that reds the job rather than
recording a fake clean review. It is hard-gated to same-repo, non-draft,
non-Dependabot PRs, because fork code must never run with access to the API key. It sleeps
60 seconds first so rapid pushes cancel at zero model cost, sequences behind the external
review bots and skips findings they already reported, and escalates to a deeper fan-out at
≥600 changed lines or ≥40 files — or whenever a PR carries the `review:deep` label. All
GitHub I/O is deterministic code in `.github/scripts/review-orchestrator.mjs`; the model
step only emits structured findings.

## Where your PR gets deployed

A PR against `main` gets **two** previews, on two providers, and they are not
equivalent. (A fork PR gets the Pulumi one only once a maintainer approves the run — see
[Preview lifecycle](#preview-lifecycle).)

| Preview                 | URL                                                                           | What it is                                                                                      | Use it for                                                         |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Render (auto)           | `https://thunderbolt-pr-<n>.onrender.com`                                     | The web app, deployed by Render                                                                 | Quick UI checks; it is what Lighthouse scores                      |
| Pulumi stack on Fargate | `app-pr-<n>.preview.thunderbolt.io` (plus `api-pr-<n>`, `thunderbolt-pr-<n>`) | The PR's own backend, frontend and marketing services, with their own logical Postgres database | Anything touching sync, SSO, migrations, or cross-device behaviour |

The Render preview is configured in the Render dashboard, not in this repo — there is no
blueprint file here. Two places in the codebase do know about it:
`deploy/docker/backend-entrypoint.sh` appends `RENDER_EXTERNAL_URL` to `CORS_ORIGINS` when
`IS_PULL_REQUEST=true`, and the frontend treats the hostname as a preview —
`isPrPreview()` in [src/lib/platform.ts](../../src/lib/platform.ts) matches
`thunderbolt-pr-<n>.onrender.com` and
[src/contexts/sign-in-modal-context.tsx](../../src/contexts/sign-in-modal-context.tsx)
bypasses the waitlist there. That last one matters when you are testing the waitlist flow:
on Render it is off, on the Pulumi stack it is not.

The Pulumi preview publishes the PR's images to GHCR under a `pr-<n>-<sha>` tag, then
deploys the `preview-pr-<n>` stack and leaves a sticky comment listing five URLs
(marketing, app, api, auth, powersync). Only the first three are per-PR: the per-PR stack
creates ALB host rules and Cloudflare CNAMEs for marketing, app and api alone
([per-pr-stack.ts](../../deploy/pulumi/src/per-pr-stack.ts)), while Keycloak and PowerSync
belong to the shared stack and answer on their own `*.shared.preview.thunderbolt.io`
hostnames. Sign in through the shared Keycloak realm with `demo@thunderbolt.io` / `demo`.

Render is also the production host for the `powersync` service, and it does **not**
auto-deploy: after a sync-rule change merges and `images-publish.yml` has published a new
`thunderbolt-powersync` image, someone must roll that service by hand. That two-PR sequence
is documented in
[docs/architecture/powersync-account-devices.md](../architecture/powersync-account-devices.md).

## Preview lifecycle

Per-PR stacks are slim: they read the VPC, ALB, Postgres, Keycloak and PowerSync from the
long-lived `previews-shared` stack through a Pulumi `StackReference`. **The shared stack
must exist before any per-PR deploy can succeed** — it is created and updated only by
`previews-shared-deploy.yml`, whose weekly run doubles as a drift check. Each PR gets its
own OIDC client in the shared Keycloak realm, so a PR that needs different realm config, or
different PowerSync sync rules, cannot use the shared model and has to fall back to a
monolithic deploy with `shared_stack_name` left empty; see
[SHARED.md](../../deploy/pulumi/SHARED.md) for that escape hatch and its trade-offs.

Fork PRs deploy through `pull_request_target` behind the `fork-preview-approval`
environment, so a maintainer approves **every push**, not every PR. If you are reviewing a
fork contribution and the preview run sits pending with no explanation, that gate is why.
Under that trigger both the workflow file and the Pulumi program are read from `main`, so a
fork can change what is inside the images but never the infrastructure code that deploys
them.

Teardown happens on close, hourly as a safety net, and by hand. `preview-destroy.yml` fires
when the PR closes. Before `pulumi destroy`, it runs `scripts/drop-preview-db.sh`, which
must go first — it needs the
per-stack secrets and backend task definition that the stack itself owns — and which exists
because Pulumi does not drop the logical database. Each PR gets its own database on the
shared Postgres instance, created at backend startup by
`deploy/docker/backend-entrypoint.sh` when `POSTGRES_ADMIN_URL` is set. Left behind, its
`__drizzle_migrations` content hashes leak into the next deploy of the same PR number and
`drizzle-kit` fails once a migration has been re-edited. The destroy job runs even if the
drop fails, so a flaky drop cannot orphan an ALB and leak cost.

`preview-cleanup.yml` is the hourly safety net for what the destroy path missed: a failed
teardown, a PR closed out of band, or an open PR idle for more than `max_age_days` (default
3). It enumerates only stacks matching `^preview-pr-[0-9]+$` in this Pulumi project, so it
cannot reach a production stack. Add the **`preview:persist`** label to keep a stack alive
past those rules — the right move for a demo or QA environment pinned to one PR.
`workflow_dispatch` takes a `dry_run` input that lists what would be destroyed.

Both `preview-deploy.yml` and `preview-destroy.yml` also accept a `pr_number` via
`workflow_dispatch`, which is how you redeploy a stack after a failed run or force a
teardown outside the normal lifecycle.

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

The shim is the one non-obvious entry in that list. Bun has no Babel pass, so importing a
Lingui macro under plain `bun run` resolves to a stub whose exports throw when called — and
the eval CLIs reach UI modules transitively. Every `eval*` script in `package.json`
therefore runs as `bun --preload ./scripts/lingui-macro-bun-shim.ts …`, and `evals.yml`
invokes them through those scripts. A new Bun entry point that imports app code needs the
same preload; Bun tests get the equivalent from `src/testing-library.ts` instead.

## See also

- [Testing](./testing.md) — what each test command covers and how to run it
- [backend/docs/testing.md](../../backend/docs/testing.md) — the backend suite and its
  CI-only differences
- [deploy/README.md](../../deploy/README.md) — deploy workflow inputs, secrets, and the
  enterprise path
- [deploy/pulumi/SHARED.md](../../deploy/pulumi/SHARED.md) — shared/per-PR preview stack
  architecture
- [RELEASE.md](../../RELEASE.md) — release, version-bump and platform build workflows

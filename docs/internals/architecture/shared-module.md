# The `shared/` Module

`shared/` holds the contracts that the React app (`src/`), the backend (`backend/src/`), and the single-binary CLI
(`cli/src/`) must agree on. Each consumer has its own dependency tree, TypeScript program, and CI job; nothing in
`shared/` imports from any of them.

## What lives here

| Kind                                 | Modules                                                                                                                                                      | What drift would cost                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| HTTP/WS wire contract                | `proxy-protocol.ts`, `ws-bearer.ts`, `acp-types.ts`, `inference-usage.ts`, `debug-transcript-contract.ts`, `tinfoil-proxy.ts`, `iroh.ts`, `cli-device-id.ts` | A renamed header, path, error code, or ALPN string that compiles on both sides and fails at runtime |
| Mirrored type                        | `types/auth.ts`, `defaults/models.ts` (`SharedModel`), `powersync-tables.ts`                                                                                 | A schema change on one side that the other side keeps claiming to know                              |
| Shipped default data                 | `defaults/models.ts`, `lib/hash.ts`                                                                                                                          | Hash drift silently invalidates every `defaultHash` already stored in user databases                |
| Pure helper on a path both ends walk | `compare-semver.ts`, `ip-classification.ts`, `url.ts`, `agent-tool-permissions.ts`, `lib/is-record.ts`, `i18n/locales.ts`, `i18n/base-language.ts`           | Two implementations of one rule (version gating, private-address blocking, locale negotiation)      |

About twenty modules in all, plus `shared/agent-core/` and two tooling configs (`shared/eslint/base.js`,
`shared/tsconfig.base.json`).

**The admission test:** two independently deployed pieces of code must agree on a value, and disagreement would fail
_silently_ rather than loudly (the header comments of `proxy-protocol.ts`, `ws-bearer.ts`, `acp-types.ts`, and
`tinfoil-proxy.ts` each state it). A helper that is merely useful twice is not a contract; duplicate it or leave it
with its owner. Presence in the tree proves nothing: `agent-tool-permissions.ts` has one consumer (`cli/src`) today.

`shared/i18n/locales.ts` must stay free of runtime imports: `lingui.config.ts` loads it outside Vite and the backend
validates against it. That rule and the version-bump discipline around `defaults/models.ts` live in
[AGENTS.md](../../../AGENTS.md#reconciled-defaults-and-version-bumps) and its
[`X-App-Language`](../../../AGENTS.md#the-x-app-language-header) section.

## One file, three runtimes

A shared module runs in three places: a Vite browser bundle, a long-lived Bun server (`backend/package.json` compiles
`src/cluster.ts` with `bun build --compile`), and cross-compiled binaries (`cli/package.json` `build:darwin-arm64`,
`build:linux-x64`, `build:linux-arm64`). Three consequences:

- **No dependencies.** Outside `shared/agent-core`, nothing imports a non-sibling; tests import `bun:test` only. Root,
  `backend/`, and `cli/` are three installs from three lockfiles (`bun.lock`, `backend/bun.lock`, `cli/bun.lock`), so
  an npm import that resolves for the frontend can fail the CLI build.
- **No React, no DOM.** Nothing in `shared/` imports `react`; `eslint.config.js` gives `shared/**` its own block with
  Node and Bun globals and no React rules. The CLI's typecheck enforces the DOM half (below).
- **Relative imports inside the tree.** The frontend and backend map `@shared/*`; the CLI has no `paths` mapping, so a
  `@shared/...` import _inside_ a shared module breaks the CLI.

## How each consumer imports it

| Consumer | Specifier                            | Wiring                                                                                                             |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Frontend | `@shared/defaults/models`            | `tsconfig.json:10`, `vite.config.ts:138`                                                                           |
| Backend  | `@shared/defaults/models`            | `backend/tsconfig.json:12`                                                                                         |
| CLI      | `../../../shared/defaults/models.ts` | no path mapping; the explicit `.ts` is legal because `shared/tsconfig.base.json` sets `allowImportingTsExtensions` |

`backend/tsconfig.json:16-29` enumerates nine shared files in `include`, but that is **not** a gate: TypeScript pulls
imported files in regardless. `tsc --listFiles` reports sixteen; the seven unlisted (`ip-classification`,
`inference-usage`, `defaults/models`, `cli-device-id`, `debug-transcript-contract`, `tinfoil-proxy`, and `lib/hash`
via `defaults/models`) arrive through imports alone, so a new shared import needs no edit there.

## What each check covers

| Command                            | Sees                                                           | `lib`                                                    |
| ---------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `bun run type-check` (root)        | all of `shared/` (`include: ["src", "shared"]`)                | `ES2023` + `DOM` (`tsconfig.json:6`)                     |
| `cd backend && bun run type-check` | the shared files the backend imports, plus the nine enumerated | `lib` unset, so the `ESNext` default, which includes DOM |
| `cd cli && bun run typecheck`      | only the shared files the CLI imports                          | `ES2023`, no DOM (`cli/tsconfig.json:5`)                 |

**The CLI's narrower `lib` bites.** A module touching a DOM API typechecks at the root and in the backend, then fails
only in the CLI with `TS2584: Cannot find name 'document'`, reported against the shared file. Hold anything the CLI reaches to ECMAScript plus
`@types/bun`.

**Tests are enumerated, not discovered.** `bun run test` (`package.json:9`) runs the frontend suite with `--cwd=src`,
then names `shared/*.test.ts`, `shared/defaults/`, `shared/i18n/`. A test anywhere else (`shared/lib/`,
`shared/types/`, a new subdirectory) runs nowhere. `shared/agent-core` has its own runner (`bun run test:agent-core`);
see [testing.md](../development/testing.md).

**Lint and format belong to the root workspace.** `package.json:35` runs `eslint src shared`, `:37` formats
`{src,shared}/**`, and `cli/` has no eslint config. `shared/eslint/base.js` exports plain config objects and imports
no packages, so `eslint.config.js` and `backend/eslint.config.js` each resolve parsers and plugins from their own
`node_modules`.

**CI path-gates the CLI, not the other two.** `typescript` and `backend` carry no `if:`; `cli` and `agent-core` run
only when their path filters match (`.github/workflows/ci.yml:302-304`, `:258-260`). The `cli` filter lists four shared
paths (`:59-62`):

| In the `cli` filter                                                                                         | Imported by the CLI but unlisted                                                                               |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `shared/agent-core/**`, `shared/cli-device-id.ts`, `shared/defaults/models.ts`, `shared/inference-usage.ts` | `shared/agent-tool-permissions.ts`, `shared/ip-classification.ts`, `shared/iroh.ts`, `shared/lib/is-record.ts` |

Change an unlisted module and the CLI's typecheck, 5× test run, and binary build never run. Add the path in the same
PR.

## Mirrored definitions are pinned at compile time

Three modules restate a definition canonical elsewhere; none rely on a comment to stay in step.

- **`shared/types/auth.ts`** mirrors the Drizzle `user` row so frontend code gets `User` without Drizzle.
  `backend/src/db/auth-schema.ts:191-194` asserts assignability both ways, so a column added on either side fails the
  backend typecheck.
- **`SharedModel` in `shared/defaults/models.ts`** restates the model shape without `apiKey`; `src/types.ts:145`
  asserts it is assignable to `Omit<Model, 'apiKey'>`, so a new required field on `Model` fails the frontend typecheck.
  The key is omitted because the DAL `LEFT JOIN`s it in from `models_secrets`, a `localOnly` table
  (`src/db/powersync/schema.ts:30-33`) that never syncs.
- **`shared/powersync-tables.ts`** names the synced tables; `backend/src/dal/powersync.ts:17-18` derives the upload
  validator and the accept-and-ignore legacy set from it. Adding or retiring a table:
  [powersync-account-devices.md](powersync-account-devices.md).

`shared/lib/hash.ts` is a fourth kind: its output persists as `defaultHash` in user databases, so changing the
algorithm invalidates every hash in the wild. The backend reaches it transitively through `@shared/defaults/models`.

## `shared/agent-core` is the exception

The in-browser adapter around the npm Pi harness. It breaks the no-dependencies rule on purpose, importing
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@anthropic-ai/sdk`, `@zenfs/core`, `@zenfs/dom`, `just-bash`,
`ai`, `zod`, `typebox`, and Node builtins.

- **Browser-safety comes from Vite aliases alone.** `vite.config.ts:161-178` aliases the Node builtins it reaches
  (`module`, `fs`, `fs/promises`, `crypto`) to stubs in `shared/agent-core/browser-stubs/`, and `path` to
  `path-browserify`. Those aliases exist in the frontend build only.
- **The CLI therefore imports only leaf modules** whose transitive dependencies it has installed:
  `openai-compat-model`, `confidential-model`, `skills`, `client-identity`. Both `package.json` files pin
  `@earendil-works/pi-*` to the same exact version; since `shared/agent-core` resolves them from the root tree and CLI
  code from `cli/node_modules`, a CI step compares the resolved `@earendil-works/pi-ai` and `openai` versions across
  the installs and fails on a mismatch (`.github/workflows/ci.yml:334-335`).
- **The barrel loads dynamically.** `shared/agent-core/index.ts` starts with a side-effect import installing the Node
  globals Pi reads at module scope (`index.ts:14`), then re-exports the harness. `src/acp/built-in-adapter.ts:842`
  loads it via dynamic `import()` so it lands in its own chunk; `scripts/agent-core-browser-check.ts:35-36` asserts the
  build emits exactly one `agent-core-*.js`.
- **Static references to the barrel stay type-only.** A static _value_ import would pull the harness back into the
  entry graph, so app code uses `import type` (`built-in-conversation.ts`, `built-in-adapter.ts`, plus
  `typeof import(...)` for the module type). `@shared/agent-core/skills` and `@shared/agent-core/client-identity` are
  the statically-importable leaf paths.

Unit tests and the two-engine browser check: [testing.md](../development/testing.md).

## Adding a module

1. Put the file at the top level of `shared/`, or under `lib/` if it is a pure helper.
2. Import its siblings relatively; add no dependency.
3. If the CLI will import it, confirm it typechecks under the CLI's DOM-free `lib` and add its path to the `cli` filter
   in `.github/workflows/ci.yml`.
4. If it ships a test, put the test where `bun run test` looks, or extend the enumeration in `package.json`.

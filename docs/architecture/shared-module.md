# The `shared/` Module

`shared/` holds the code that more than one workspace has to agree on. Three consumers import from it — the React app
in `src/`, the backend in `backend/src/`, and the single-binary CLI in `cli/src/` — and each has its own dependency
tree, its own TypeScript program, and its own CI job. Nothing in `shared/` imports from any of them: the arrows point
inward only, which is what makes it safe for a contract to live here.

The tree is deliberately small — about twenty modules plus the `shared/agent-core/` subsystem and two tooling configs
(`shared/eslint/base.js`, `shared/tsconfig.base.json`). It is not a utility drawer.

## What belongs here

A module earns a place in `shared/` when two independently deployed pieces of code must agree on the same value, and
disagreement would fail _silently_ rather than loudly. `shared/proxy-protocol.ts` states the test in its own header:
"The two ends form one wire contract — drift here is silent breakage, so all header names and prefix strings live in one
place." The same framing opens `shared/ws-bearer.ts`, `shared/acp-types.ts`, and `shared/tinfoil-proxy.ts`.

Four kinds of thing pass that test today.

| Kind                                 | Modules                                                                                                                                                      | What drift would cost                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| HTTP/WS wire contract                | `proxy-protocol.ts`, `ws-bearer.ts`, `acp-types.ts`, `inference-usage.ts`, `debug-transcript-contract.ts`, `tinfoil-proxy.ts`, `iroh.ts`, `cli-device-id.ts` | A renamed header, path, error code, or ALPN string that compiles on both sides and fails at runtime         |
| Mirrored type                        | `types/auth.ts`, `defaults/models.ts` (`SharedModel`), `powersync-tables.ts`                                                                                 | A schema change on one side that the other side keeps claiming to know                                      |
| Shipped default data                 | `defaults/models.ts`, `lib/hash.ts`                                                                                                                          | Hash drift silently invalidates every `defaultHash` already stored in user databases                        |
| Pure helper on a path both ends walk | `compare-semver.ts`, `ip-classification.ts`, `url.ts`, `agent-tool-permissions.ts`, `lib/is-record.ts`, `i18n/locales.ts`, `i18n/base-language.ts`           | Two implementations of one rule (version gating, private-address blocking, locale negotiation) that diverge |

Everything else stays in the workspace that owns it: React components, Drizzle schemas, route handlers, TUI code. A
helper that merely happens to be useful twice is not a contract — duplicate it, or keep it where its owner lives.
Presence in the tree is not proof of multiple consumers either: `shared/agent-tool-permissions.ts` is imported only by
`cli/src` today.

Two i18n modules live here for a reason worth knowing before you move them: `shared/i18n/locales.ts` is loaded by
`lingui.config.ts` outside Vite and validated against by the backend, so it must stay free of runtime imports. That
rule, and the version-bump discipline around `defaults/models.ts`, are covered in
[AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps) and its
[`X-App-Language`](../../AGENTS.md#the-x-app-language-header) section.

## One file, three runtimes

A shared module is bundled into a browser by Vite, evaluated by Bun in a long-lived server process
(`backend/package.json` compiles `src/cluster.ts` with `bun build --compile`), and embedded in a cross-compiled
standalone binary (`cli/package.json` `build:darwin-arm64`, `build:linux-x64`, `build:linux-arm64`). Three consequences
follow, and all three currently hold across the tree:

- **No dependencies.** Outside `shared/agent-core`, no module imports anything but a relative sibling — test files
  import `bun:test` and nothing else. The root, `backend/`, and `cli/` trees are three separate installs from three
  lockfiles (`bun.lock`, `backend/bun.lock`, `cli/bun.lock`), so an npm import that resolves for the frontend can be a
  build failure for the CLI.
- **No React, no DOM.** Nothing in `shared/` imports `react`. `eslint.config.js` gives `shared/**` its own block with
  Node and Bun globals and none of the React rules, and the DOM half is enforced by the CLI's typecheck (below).
- **Relative imports inside the tree.** The frontend and backend map `@shared/*`; the CLI has no `paths` mapping at all.
  A `@shared/...` import _inside_ a shared module would resolve for two consumers and break the third.

## How each consumer imports it

| Consumer | Specifier                            | Wiring                                                                                                             |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Frontend | `@shared/defaults/models`            | `tsconfig.json:10`, `vite.config.ts:138`                                                                           |
| Backend  | `@shared/defaults/models`            | `backend/tsconfig.json:12`                                                                                         |
| CLI      | `../../../shared/defaults/models.ts` | no path mapping; the explicit `.ts` is legal because `shared/tsconfig.base.json` sets `allowImportingTsExtensions` |

`backend/tsconfig.json:16-29` additionally enumerates nine shared files in its `include`. That list is **not** a gate:
TypeScript pulls imported files into the program whether or not they are listed. `tsc --listFiles` on the backend
project reports sixteen shared files, and the seven beyond the enumeration arrive purely through imports —
`ip-classification`, `inference-usage`, `defaults/models`, `cli-device-id`, `debug-transcript-contract`,
`tinfoil-proxy`, and `lib/hash` transitively via `defaults/models`. Adding a new shared import does not require editing
it.

## What each check actually covers

The three typecheck programs see different subsets of the tree under different `lib` settings.

| Command                            | Sees                                                           | `lib`                                                  |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| `bun run type-check` (root)        | all of `shared/` — `include: ["src", "shared"]`                | `ES2023` + `DOM` (`tsconfig.json:6`)                   |
| `cd backend && bun run type-check` | the shared files the backend imports, plus the nine enumerated | `lib` unset — the `ESNext` default, which includes DOM |
| `cd cli && bun run typecheck`      | only the shared files the CLI imports                          | `ES2023`, no DOM (`cli/tsconfig.json:5`)               |

The CLI's narrower `lib` is the one that bites. A shared module that touches a DOM API typechecks at the root and in the
backend and fails only in the CLI, with `TS2584: Cannot find name 'document'. Do you need to change your target
library? Try changing the 'lib' compiler option to include 'dom'` reported against the shared file. If the CLI reaches a
module, hold it to ECMAScript plus what `@types/bun` declares.

**Tests are enumerated, not discovered.** `bun run test` (`package.json:9`) runs the frontend suite with `--cwd=src` and
then names three shared paths explicitly: `shared/*.test.ts`, `shared/defaults/`, `shared/i18n/`. A test placed anywhere
else in the tree — `shared/lib/`, `shared/types/`, a new subdirectory — is run by nothing. `shared/agent-core` has its
own runner (`bun run test:agent-core`). The reasoning behind the enumeration is in
[testing.md](../development/testing.md).

**Lint and format belong to the root workspace.** `package.json:35` runs `eslint src shared` and `:37` formats
`{src,shared}/**`; `cli/` has no eslint config of its own. The rules themselves live in `shared/eslint/base.js`, which
exports plain config objects and imports no packages — deliberately, so that `eslint.config.js` and
`backend/eslint.config.js` each resolve parsers and plugins from their own `node_modules`.

**CI path-gates the CLI, not the other two.** The `typescript` and `backend` jobs carry no `if:` and run on every PR;
`cli` and `agent-core` run only when their path filters match (`.github/workflows/ci.yml:302-304` and `:258-260`).
The `cli` filter lists four shared paths (`:59-62`) — `shared/agent-core/**`, `shared/cli-device-id.ts`,
`shared/defaults/models.ts`, `shared/inference-usage.ts` — but the CLI also imports
`shared/agent-tool-permissions.ts`, `shared/ip-classification.ts`, `shared/iroh.ts`, and `shared/lib/is-record.ts`.
Change one of those four unlisted modules and the CLI's typecheck, 5× test run, and binary build never execute. Add the
path to the filter in the same PR.

## Mirrored definitions are pinned at compile time

Three shared modules restate a definition that is canonical somewhere else. None of them rely on a comment to stay in
step:

- `shared/types/auth.ts` mirrors the Drizzle `user` row so frontend code can have the `User` type without depending on
  Drizzle. `backend/src/db/auth-schema.ts:191-194` asserts assignability in both directions, so a column added on either
  side fails the backend typecheck.
- `SharedModel` in `shared/defaults/models.ts` restates the model shape without `apiKey` — omitted on purpose, because
  the key is `LEFT JOIN`ed in by the DAL from `models_secrets`, a `localOnly` table (`src/db/powersync/schema.ts:30-33`)
  that never syncs. `src/types.ts:145` asserts every `SharedModel` is assignable to `Omit<Model, 'apiKey'>`, so a new
  required field on `Model` fails the frontend typecheck until the shared type covers it.
- `shared/powersync-tables.ts` names the synced tables, and `backend/src/dal/powersync.ts:17-18` derives the upload
  validator and the accept-and-ignore legacy set from it. The list is load-bearing at runtime; adding or retiring a
  table has its own procedure in [powersync-account-devices.md](./powersync-account-devices.md).

`shared/lib/hash.ts` is a contract of a fourth kind: its output is persisted in user databases as `defaultHash`, so a
change to the algorithm invalidates every hash already in the wild. The backend reaches it transitively through
`@shared/defaults/models`.

## `shared/agent-core` is the exception

`shared/agent-core/` is the app's in-browser adapter around the npm Pi harness, and it breaks the no-dependencies rule
on purpose: it imports `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@anthropic-ai/sdk`, `@zenfs/core`,
`@zenfs/dom`, `just-bash`, `ai`, `zod`, `typebox`, and Node builtins. It is browser-safe only because
`vite.config.ts:161-178` aliases the Node builtins it reaches (`module`, `fs`, `fs/promises`, `crypto`) to the stubs in
`shared/agent-core/browser-stubs/`, and `path` to `path-browserify`. Those aliases exist in the frontend build alone.

The CLI therefore imports only the leaf modules whose transitive dependencies it has installed — `openai-compat-model`,
`confidential-model`, `skills`, `client-identity` — and both `package.json` files pin `@earendil-works/pi-*` to the same
exact version. Because `shared/agent-core` resolves those packages from the root tree while CLI code resolves them from
`cli/node_modules`, a CI step compares the resolved versions of `@earendil-works/pi-ai` and `openai` across the two
installs and fails on a mismatch (`.github/workflows/ci.yml:334-335`).

The barrel at `shared/agent-core/index.ts` opens with a side-effect import that installs the Node globals Pi reads at
module scope (`index.ts:14`) and re-exports the whole harness. `src/acp/built-in-adapter.ts:842` loads it through a
dynamic `import()` so it lands in its own chunk, and `scripts/agent-core-browser-check.ts:35-36` asserts the production
build emits exactly one `agent-core-*.js`. A static _value_ import of the barrel would pull the harness back into the
entry graph, so app code's static references to it are type-only (`import type` in `built-in-conversation.ts` and
`built-in-adapter.ts`, plus `typeof import(...)` for the module type) and erase at build time. Leaf paths such as
`@shared/agent-core/skills` and `@shared/agent-core/client-identity` are the statically-importable surface. Its unit
tests and the two-engine browser check are documented in [testing.md](../development/testing.md).

## Adding a module

Put the file at the top level of `shared/`, or under `lib/` if it is a pure helper; import its siblings relatively; add
no dependency. If the CLI will import it, confirm it typechecks under the CLI's DOM-free `lib` and add its path to the
`cli` filter in `.github/workflows/ci.yml`. If it ships a test, put the test where `bun run test` looks — or extend the
enumeration in `package.json`.

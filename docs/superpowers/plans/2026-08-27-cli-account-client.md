# Thunderbolt CLI Account Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. The root agent only coordinates context, ownership, reviews, and handoffs; every edit and check is delegated. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `thunderbolt` a first-class, device-bound account client with multiple BYOK profiles, all current managed models, confidential GLM, direct/ACP parity, remote revocation, and no PowerSync or prompt replay.

**Architecture:** The backend reuses Better Auth sessions and the existing `devices` table, adding only the `cli-<UUID>` namespace/type and two account routes. Shared public catalog data derives from current defaults; private runtime/pricing policy stays backend-only. The CLI freezes all types before parallel work, adapts BYOK/direct/Tinfoil into `PreparedPiBinding`, and runs one `HarnessRuntime` that solely owns prompt-active state, provider installation, switching, deactivation, and cleanup. Pi remains the only engine.

**Tech Stack:** TypeScript 6, Bun 1.3, Elysia, Better Auth 1.6, Drizzle/PostgreSQL/PGlite, PowerSync schema types, React 19, Pi 0.80.7, Tinfoil `SecureClient`, Bun test, configured ESLint, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-cli-account-client-design.md`

**Global Constraints:**

- Execution mode is already chosen: subagent-driven. Do not ask the user to choose again.
- Maximum concurrency is three subagents plus the root. Parallel task file sets are disjoint.
- TDD is mandatory for every production behavior: add the exact failing test, run the listed RED command, observe the specified failure, then edit production.
- Acceptance-only tests after reviewed producers may pass immediately; do not manufacture a failure.
- After every task, the implementer runs targeted tests, configured typecheck/lint/build, `git diff --check`, and an explicit simplification/cleanup pass.
- After every task, the root dispatches a non-author spec-compliance reviewer and a different non-author code-quality reviewer. Reviewers do not edit. Repairs are delegated and receive both reviews again.
- After every round, another non-author reviews the combined diff and reruns round checks. No later round starts with an open finding.
- Use Bun only. Never run bare `bun test` at repository root. Use `bun run test`, `bun run test:backend`, or specific `bun test <path> --timeout 5000` commands.
- Oxlint is excluded and unconfigured. Use root/backend ESLint only where existing scripts cover changed files. The CLI uses tests, typecheck, and compiled build.
- Never use `any`. Prefer `type`, arrow functions, `const`, early returns, direct imports, async/await, and JSDoc for new utilities.
- Preserve unrelated changes. Local research artifacts remain outside every task, diff, and commit.
- Do not create another worktree. If execution starts detached, delegate branch creation in preflight.
- Do not run `git add`, `git commit`, or `git push`. Every task ends with: “Review checkpoint: record changed files and diff; do not commit.”
- Add no table, column, or token family. `device_type` is existing PostgreSQL text; verify no migration diff and never hand-write SQL.
- The CLI never initializes PowerSync or syncs chats, prompts, settings, provider profiles, secrets, tools, or sessions.
- Add Tinfoil only through `cd cli && bun add tinfoil@latest`. One task owns `cli/package.json` and `cli/bun.lock`.

## Mandatory task and round gates

Every task prompt includes its full section, this header, and the spec path. Its final checkbox performs all of these actions:

1. Implementer records RED and GREEN output, typecheck/lint/build output, changed files, and cleanup decisions.
2. Root dispatches a spec reviewer to verify the task against its Produced/Consumed Interfaces and spec criteria.
3. Root dispatches a code-quality reviewer to rerun checks and inspect security, simplicity, style, unused code, and test strength.
4. Findings are repaired by a delegated agent; both reviews repeat.
5. Root records `git status --short` and `git diff -- <owned files>`; no commit occurs.

After each round, a new non-author reviewer reruns the round command set, validates disjoint ownership, and approves interface freeze.

## Frozen central interfaces — produced once in Task 5

Later tasks import these types from `cli/src/provider-runtime/types.ts`; they do not redefine them.

```ts
export type AccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type ManagedCatalogLoader = (backendUrl: string, fetchFn?: AccountFetch) => Promise<ManagedModels>
export type ProviderStatus = 'authenticated' | 'not authenticated' | 'authentication required'
export type CredentialProvenance = 'stored-byok' | 'environment' | 'flag' | 'stored-session' | 'pat'
export type DeviceGrantPresentation = {
  readonly showVerification: (value: { readonly verificationUrl: string; readonly userCode: string; readonly qrBlock?: string }) => void
  readonly showStatus: (status: 'waiting' | 'success' | 'error', message?: string) => void
}
export type ProviderManagerItem = { readonly id: string; readonly label: string; readonly description?: string }
export type ProviderManagerIO = DeviceGrantPresentation & {
  readonly choose: (title: string, items: readonly ProviderManagerItem[]) => Promise<string | null>
  readonly readText: (prompt: string) => Promise<string | null>
  readonly readSecret: (prompt: string) => Promise<string | null>
  readonly write: (text: string) => void
}

export type ByokProfile = {
  readonly id: string
  readonly label: string
  readonly defaultModel: string
  readonly apiKey: string | null
  readonly credentialStatus: 'authenticated' | 'authentication-required'
} & ({ readonly provider: BuiltinProvider } | { readonly provider: 'openai-compat'; readonly baseUrl: string })

export type CliConfig = {
  readonly version: 2
  readonly activeProviderId: 'thunderbolt' | string | null
  readonly thunderbolt: { readonly defaultModelId: string }
  readonly providers: readonly ByokProfile[]
}

export type CliAuth = {
  readonly version: 2
  readonly backendUrl: string
  readonly deviceId: `cli-${string}`
  readonly userCacheSecret: string
} & (
  | { readonly registration: 'legacy' | 'registered'; readonly bearer: string }
  | { readonly registration: 'authentication-required'; readonly bearer: null }
)

export type ResolvedAccountCredential =
  | { readonly type: 'session'; readonly backendUrl: string; readonly bearer: string; readonly deviceId: `cli-${string}`; readonly userCacheSecret: Uint8Array }
  | { readonly type: 'pat'; readonly backendUrl: string; readonly token: string }

export type InvocationSelection = { readonly providerId?: 'thunderbolt' | string; readonly model?: string; readonly apiKey?: string; readonly baseUrl?: string }
export type ProviderCommand =
  | { readonly type: 'use'; readonly providerId: 'thunderbolt' | string }
  | { readonly type: 'save-byok'; readonly profile: ByokProfile }
  | { readonly type: 'remove-byok'; readonly providerId: string }
  | { readonly type: 'select-model'; readonly providerId: 'thunderbolt' | string; readonly model: string }
  | { readonly type: 'login'; readonly presentation: DeviceGrantPresentation }
  | { readonly type: 'logout'; readonly presentation: DeviceGrantPresentation }
  | { readonly type: 'clear-active' }
  | { readonly type: 'mark-authentication-required'; readonly providerId: 'thunderbolt' | string }

export type ProviderSnapshot = {
  readonly revision: number
  readonly activeProviderId: 'thunderbolt' | string | null
  readonly thunderbolt: { readonly status: ProviderStatus; readonly defaultModelId: string }
  readonly providers: readonly { readonly id: string; readonly label: string; readonly provider: string; readonly status: ProviderStatus; readonly defaultModel: string }[]
}

export type ProviderRuntimeError = {
  readonly code: 'config-invalid' | 'config-version-unsupported' | 'provider-not-found' | 'model-not-found' | 'authentication-required' | 'authentication-rejected' | 'device-disconnected' | 'WEB_LOGIN_REQUIRED' | 'quota-exceeded' | 'network' | 'attestation-failed' | 'transport-unsupported' | 'persistence-failed'
  readonly phase: 'load' | 'auth' | 'catalog' | 'prepare' | 'request' | 'stream' | 'persist' | 'cleanup'
  readonly message: string
  readonly retry: 'manual' | 'after-login' | 'after-wait' | 'after-upgrade' | 'none'
  readonly requestMayHaveBeenAccepted: boolean
}

export type PreparedPiBinding = {
  readonly providerId: 'thunderbolt' | string
  readonly modelId: string
  readonly wireModel: string
  readonly credentialProvenance: CredentialProvenance
  readonly piModel: Model<Api>
  readonly install: (models: MutableModels) => void
  readonly attach: (harness: AgentHarness) => () => void
  readonly observePromptError: (error: unknown) => Promise<void>
  readonly dispose: () => Promise<void>
}

export type HarnessRuntime = {
  readonly subscribe: (listener: (event: AgentHarnessEvent) => void) => () => void
  readonly registerToolCallGate: (handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined>) => void
  readonly prompt: (text: string) => Promise<AssistantMessage>
  readonly waitForIdle: () => Promise<void>
  readonly abort: () => Promise<void>
  readonly switchBinding: (binding: PreparedPiBinding, persist: () => Promise<void>, options: { readonly forceReplace: boolean }) => Promise<void>
  readonly deactivate: (persist: () => Promise<void>, options: { readonly onPersistFailure: 'restore-binding' | 'remain-deactivated' }) => Promise<void>
  readonly dispose: () => Promise<void>
}

export type ProviderRuntime = {
  readonly snapshot: () => ProviderSnapshot
  readonly manage: (command: ProviderCommand) => Promise<ProviderSnapshot>
  readonly prepare: (selection: InvocationSelection) => Promise<PreparedPiBinding>
}

export type CommandOutcome =
  | { readonly kind: 'switch'; readonly selection: InvocationSelection; readonly persist: ProviderCommand; readonly forceReplace: boolean }
  | { readonly kind: 'deactivate'; readonly persist: ProviderCommand }
  | { readonly kind: 'handled' }
  | { readonly kind: 'forward'; readonly text: string }
  | { readonly kind: 'exit' }
export type ProviderManagerMode = 'providers' | 'models' | 'first-run' | 'login' | 'logout'
export type ProviderManagerRunner = (mode: ProviderManagerMode) => Promise<CommandOutcome>
export type AccountActions = {
  readonly login: (presentation: DeviceGrantPresentation) => Promise<CliAuth>
  readonly logout: (presentation: DeviceGrantPresentation) => Promise<'logged-out' | 'pat-managed-externally' | 'authentication-required'>
}
```

## Ownership map

| Production scope | Primary owner | Later test-only extension |
| --- | --- | --- |
| Shared public catalog and direct backend map | Task 1 | Task 18 |
| Backend CLI device/session contract | Task 2 | Task 18 |
| Frontend device/approval UI | Task 3 | Task 18 |
| Backend Tinfoil PAT/receipt policy | Task 4 | Task 18 |
| Central CLI types, config/auth migration, secure files | Task 5 | Task 18 |
| CLI account register/touch/logout | Task 6 | Task 18 |
| CLI catalog client | Task 7 | Task 18 |
| CLI manifests and HarnessRuntime | Task 8 | Task 18 verification only |
| BYOK binding producer | Task 9 | Task 18 |
| Managed direct binding producer | Task 10 | Task 18 |
| Tinfoil binding/receipt producer | Task 11 | Task 18 |
| ProviderRuntime and shared prompt-error policy | Task 12 | Task 18 |
| Pure parser, command router, and production help | Task 13 | Task 16 test extension; Task 18 acceptance |
| Plain/TUI bootstrap and run loop | Task 14 | Task 18 |
| ACP startup/session integration | Task 15 | Task 18 |
| Sole `cli/src/index.ts` wiring | Task 16 | Task 18 |
| Acceptance tests only | Task 18 | none |
| Docs, CI, release workflows | Task 17 | Task 19 verification only |

---

## Task 0: Delegated preflight

**Round:** Preflight, serial

**Files:** Inspect only `package.json`, `backend/package.json`, `cli/package.json`, their lockfiles, and the spec.

**Produced Interface:** A recorded baseline containing branch, HEAD, dirty paths, dependency-install result, and root/backend/CLI check results.

- [ ] Record `git status --short`, `git branch --show-current`, and `git rev-parse --short HEAD`.
- [ ] If detached, delegate `git switch -c codex/cli-account-client`; do not create a worktree.
- [ ] Run `bun install --frozen-lockfile`, `(cd backend && bun install --frozen-lockfile)`, and `(cd cli && bun install --frozen-lockfile)`; expect no lockfile diff.
- [ ] Run `bun run type-check`, `bun run lint`, `bun run test`, `(cd backend && bun run type-check)`, `(cd backend && bun run lint)`, `(cd cli && bun run typecheck)`, and `(cd cli && bun run test)`; record pre-existing failures verbatim without fixing them.
- [ ] Complete both task reviews and the review checkpoint; do not commit.

---

# Round 1 — Backend-first public catalog, device contract, and safe app UI

Tasks 1–3 run in parallel with disjoint production files.

## Task 1: Shared catalog derived from defaults and private direct runtime map

**Files:**
- Create: `shared/managed-models.ts`, `shared/managed-models.test.ts`
- Create test support: `shared/managed-models.test-fixtures.ts`
- Modify: `shared/defaults/models.ts:19-187`, `shared/defaults/models.test.ts`
- Create: `backend/src/inference/managed-models.ts`, `backend/src/inference/managed-models.test.ts`
- Modify: `backend/src/inference/routes.ts:45-65,131-205`, `backend/src/inference/routes.test.ts`
- Modify: `backend/src/api/config.ts:20-35`, `backend/src/api/config.test.ts`
- Modify: `src/api/config-store.ts:9-28`, `src/api/config-store.test.ts`

**Produced Interfaces:** `ManagedModel`, `ManagedModels`, `managedModels`, private `managedDirectRuntimes`, a pure `createManagedModels(defaults, overlay, version, defaultModelId)` normalizer (superseded: `defaultModels.map(toManagedModel)` in the static `managedModels` catalog), and test-only `createFutureDirectManagedModelsFixture()` from `shared/managed-models.test-fixtures.ts` for Tasks 7, 10, 12, and 18.

- [ ] Add a RED test proving catalog order/IDs/slugs match all `defaultModels`, every shared presentation field matches its source row, reasoning/transport come from a minimal overlay, `version === defaultModelsVersion`, and normalized output contains no upstream/provider/price/URL fields.
- [ ] Add a fixture-only schema-v1 RED model `{id:'019f0000-0000-7000-8000-000000000001', model:'future-direct-fixture', transport:'direct'}` and prove `createManagedModels` publishes it without a model-specific branch (superseded: the fixture reuses `toManagedModel`).

```ts
expect(managedModels.models.map(({ id }) => id)).toEqual(defaultModels.map(({ id }) => id))
expect(managedModels.models.map(({ name }) => name)).toEqual(defaultModels.map(({ name }) => name))
expect(JSON.stringify(managedModels)).not.toContain('internalName')
```

- [ ] Run `bun test shared/managed-models.test.ts shared/defaults/models.test.ts --timeout 5000`; expect module-not-found RED.
- [ ] Implement a small overlay keyed by stable default ID:

```ts
const managedOverlay = {
  [defaultModelOpus5.id]: { transport: 'direct', input: ['text', 'image'], reasoning: true },
  [defaultModelDeepseekV4Flash.id]: { transport: 'direct', input: ['text'], reasoning: true },
  [defaultModelGlm52.id]: { transport: 'confidential', input: ['text'], reasoning: true },
} as const
```

Map `defaultModels` into public entries; validate non-null name/description/vendor/context window once. Do not duplicate those values in the overlay.
- [ ] Add backend RED tests proving every public direct slug has exactly one private runtime and canonical price, GLM is the only schema-v1 confidential policy, and `/config.managedModels` equals the shared normalized catalog.
- [ ] Run `(cd backend && bun test src/inference/managed-models.test.ts src/inference/routes.test.ts src/api/config.test.ts --timeout 5000)`; expect missing private map/config field RED.
- [ ] Move the existing Opus/DeepSeek private map into `backend/src/inference/managed-models.ts`, consume it from `routes.ts`, publish the additive field, and type `AppConfig.managedModels?: ManagedModels`.
- [ ] Run shared tests, `(cd backend && bun test src/inference/managed-models.test.ts src/inference/routes.test.ts src/api/config.test.ts src/inference/usage-ledger.test.ts --timeout 5000)`, root/backend typechecks, and root/backend lint; expect PASS.
- [ ] Remove duplicate catalog constants, complete both task reviews, and record the checkpoint; do not commit.

## Task 2: Atomic backend CLI device/session contract and type guards

**Files:**
- Modify: `backend/src/db/powersync-schema.ts:263-290`
- Modify: `backend/src/dal/devices.ts`, `backend/src/dal/devices.test.ts`
- Modify: `backend/src/dal/sessions.ts`, `backend/src/dal/sessions.test.ts`, `backend/src/dal/index.ts`
- Modify: `backend/src/api/account.ts`, `backend/src/api/account.test.ts`
- Modify: `backend/src/api/powersync.ts`, `backend/src/api/powersync.test.ts`
- Modify: `backend/src/api/encryption.ts`, `backend/src/api/encryption.test.ts`
- Modify: `backend/src/dal/powersync.ts`, `backend/src/dal/powersync.test.ts`

**Produced Interfaces:**

```ts
export const cliDeviceIdPrefix = 'cli-'
export const maxActiveDevicesPerUser = 10
export const isCliDeviceId: (value: string) => boolean
export const getActivePersistedSession: (database: QueryableDatabase, rawToken: string) => Promise<{ id: string; userId: string; deviceId: string | null } | null>
export const linkSessionToDeviceIfUnbound: (database: QueryableDatabase, sessionId: string, deviceId: string, userId: string) => Promise<readonly { id: string }[]> // superseded: `linkSessionToDevice` returns an explicit result union
```

- [ ] Add RED tests for an expired but correctly signed bearer on register and logout; assert 401 and no row/session mutation.
- [ ] Add RED tests for exact CLI row fields, null-or-same bind, bind race, cap, idempotent touch, collisions, tombstone, PAT/synthetic/anonymous rejection, remote revoke, and self-logout.
- [ ] Add RED tests for reserved `cli-` uploads, PowerSync token auto-create rejection, normal/E2EE/node-ID/iroh exclusions, and E2EE remote revoke requiring a trusted normal caller.
- [ ] Run `(cd backend && bun test src/api/account.test.ts src/dal/devices.test.ts src/dal/sessions.test.ts src/dal/powersync.test.ts src/api/powersync.test.ts src/api/encryption.test.ts --timeout 5000)`; expect missing CLI contract RED before production edits.
- [ ] Add `'cli'` only to the existing Drizzle text enum. Verify `rg -n 'device_type.*text' backend/drizzle backend/drizzle/meta` and `git diff --exit-code -- backend/drizzle backend/drizzle/meta/_journal.json`; create no migration.
- [ ] Implement canonical `cli-<lowercase UUID>`, server-owned CLI upsert fields, real unexpired session lookup by raw signed token, and conditional session bind.
- [ ] Implement `PUT /v1/account/devices/cli`: require signed Bearer, acquire the existing per-user advisory lock, re-read the unexpired DB session inside the transaction, enforce null/same binding and cap, upsert/touch, conditionally bind, then return `200 {deviceId,state:'registered'}`.
- [ ] Implement `POST /v1/account/devices/cli/logout`: re-read the same unexpired persisted session inside the transaction, derive its CLI row, soft-revoke, delete all linked sessions, then return 204.
- [ ] Reserve CLI IDs and guard PowerSync/normal/E2EE/node-ID/allowlist paths; preserve current normal/bridge behavior.
- [ ] Run the RED command plus `src/auth/device-auth-apikey.test.ts`, backend typecheck/lint; expect PASS and no migration diff.
- [ ] Simplify to shared DAL/revoke helpers, complete both task reviews, and checkpoint; do not commit.

## Task 3: Conservative frontend CLI device and anonymous approval UI

**Files:**
- Modify: `src/db/tables.ts:279-306`, `src/dal/devices.ts`, `src/dal/devices.test.ts`
- Modify: `src/settings/devices.tsx`, `src/settings/devices.test.tsx`
- Modify: `src/components/revoke-device-dialog.tsx`, `src/components/revoke-device-dialog.test.tsx`
- Modify: `src/components/device-approval.tsx`, `src/components/device-approval.test.tsx`

**Consumed Interface:** Backend device type `'normal' | 'bridge' | 'cli'`; no produced cross-round interface.

- [ ] Add RED tests using a runtime-cast unknown device type; assert no pairing, E2EE approval, QR, bridge removal, or node-ID control. Add CLI active/revoked presentation tests and normal/bridge regression assertions.
- [ ] Run `bun test src/settings/devices.test.tsx src/dal/devices.test.ts src/components/revoke-device-dialog.test.tsx --timeout 5000`; expect unknown/CLI controls RED.
- [ ] Add `'cli'` to frontend types, restrict pending query to normal/legacy-null, render CLI label/last-seen/revoke only, and allow pairing only for explicitly supported normal/null/bridge cases.
- [ ] Add a RED anonymous `DeviceApproval` test proving no `/device` claim/approve request and preserved return code.
- [ ] Run `bun test src/components/device-approval.test.tsx --timeout 5000`; expect the current anonymous-as-authenticated behavior to fail.
- [ ] Implement the explicit anonymous-to-real-sign-in branch while preserving the device approval return URL.
- [ ] Run all Task 3 tests, root typecheck/lint; expect PASS.
- [ ] Keep one row component and no CLI settings page, complete both task reviews, and checkpoint; do not commit.

## Round 1 review

- [ ] Non-author reruns all Round 1 commands and verifies catalog public/private separation, unexpired atomic session binding, no SQL, reserved namespace, conservative unknown UI, anonymous web inference non-regression, and disjoint ownership.
- [ ] Repair and rereview every finding before freezing Round 1 interfaces.

---

# Round 2 — Confidential backend policy and frozen CLI state/interfaces

Tasks 4 and 5 run in parallel; their files do not overlap.

## Task 4: Backend Tinfoil PAT rejection and receipt policy

**Files:**
- Modify: `backend/src/tinfoil/routes.ts:226-272,412-456`, `backend/src/tinfoil/routes.test.ts`
- Modify: `backend/src/inference/usage-receipt-routes.ts:87-164`, `backend/src/inference/usage-receipt-routes.test.ts`
- Modify test: `backend/src/auth/device-auth-apikey.test.ts:128-224`
- Test only: `backend/src/inference/usage-receipt.test.ts`, `backend/src/inference/managed-usage.integration.test.ts`

**Consumed Interface:** Task 1 confidential catalog policy and `managedGlmIdentity`.

- [ ] Add RED tests proving a valid PAT succeeds on direct `/chat/completions` but receives `403 {error:{code:'WEB_LOGIN_REQUIRED'}}` from `/tinfoil/*` and `/inference-usage/receipts`.
- [ ] Add a RED header test proving inbound `x-api-key` never reaches the Tinfoil upstream fixture.
- [ ] Run `(cd backend && bun test src/tinfoil/routes.test.ts src/inference/usage-receipt-routes.test.ts src/auth/device-auth-apikey.test.ts --timeout 5000)`; expect PAT currently reaches confidential handlers/upstream.
- [ ] Reject requests carrying `x-api-key` before Tinfoil admission/proxy and receipt parsing; preserve Bearer, cookie/SSO, and anonymous web sessions.
- [ ] Strip `authorization`, `x-api-key`, cookies, host, connection, and enclave-routing headers before injecting the server Tinfoil bearer.
- [ ] Run the RED command plus `src/inference/usage-receipt.test.ts src/inference/managed-usage.integration.test.ts`; run backend typecheck/lint; expect PASS.
- [ ] Confirm quota/receipt claims remain GLM-only and unchanged, complete both reviews, and checkpoint; do not commit.

## Task 5: Frozen CLI interfaces, versioned state, secure reads/writes, and migrations

**Files:**
- Create: `cli/src/provider-runtime/types.ts`, `cli/src/provider-runtime/types.test.ts`
- Modify: `cli/src/config/config.ts`, `cli/src/config/config.test.ts`
- Modify: `cli/src/auth/token-store.ts`, `cli/src/auth/token-store.test.ts`
- Modify: `cli/src/lib/secure-fs.ts`, `cli/src/lib/secure-fs.test.ts`
- Modify: `cli/src/paths.ts`

**Produced Interfaces:** Every type in “Frozen central interfaces,” plus:

```ts
export const loadConfig: (path?: string) => Promise<CliConfig | null>
export const saveConfig: (config: CliConfig, path?: string) => Promise<void>
export const loadAuthConfig: (path?: string) => Promise<CliAuth | null>
export const storeAuthConfig: (auth: CliAuth, path?: string) => Promise<void>
export const clearAuthConfig: (path?: string) => Promise<void>
export const resolveAccountCredential: (env?: Readonly<Record<string, string | undefined>>) => Promise<ResolvedAccountCredential | null>
export const writeSecureFileAtomic: (dir: string, path: string, contents: string) => Promise<void>
```

- [ ] Add RED tests where the owning directory is a symlink before `mkdir/chmod`; assert rejection and untouched link target. Add target-symlink read/write tests and assert link targets remain byte-identical.
- [ ] Add RED tests proving config/auth reads enforce `0600`, the directory enforces `0700`, and interrupted atomic writes preserve original bytes.
- [ ] Run `(cd cli && bun test src/lib/secure-fs.test.ts src/config/config.test.ts src/auth/token-store.test.ts --timeout 5000)`; expect symlink/mode/migration RED.
- [ ] Implement directory `lstat` before `mkdir/chmod`, target `lstat` on read and write, same-directory exclusive temp write, chmod `0600`, atomic rename, and temp cleanup without following symlinks.
- [ ] Add RED legacy config cases for saved-key built-in, dedicated-env built-in, openai-compat stored key/base URL, and keyless profile. Assert migration is active and never opens first-run.

```ts
expect(savedKey.credentialStatus).toBe('authentication-required')
expect(envKey.credentialStatus).toBe('authentication-required')
expect(openAiCompat.credentialStatus).toBe('authentication-required')
expect(keyless.credentialStatus).toBe('authentication-required')
expect(migrated.activeProviderId).toBe(migrated.providers[0]?.id)
```

- [ ] Add RED auth migration tests proving legacy bearer/backend become `registration:'legacy'`, canonical `cli-UUID`, and 64 lowercase hex secret; invalid/future files remain byte-identical.
- [ ] Run `(cd cli && bun test src/provider-runtime/types.test.ts src/config/config.test.ts src/auth/token-store.test.ts --timeout 5000)`; expect v2 migration RED.
- [ ] Implement frozen types exactly once, strict v2 guards, the resolved credential union, lazy migrations, and unchanged `BridgeCredential` projection with PAT-first/no-fallback behavior. Every legacy profile starts last-known authentication-required because legacy state was never validated, remains active, and does not trigger first-run automatically.
- [ ] Run all Task 5 tests and CLI typecheck; expect PASS.
- [ ] Remove old unversioned types, complete both reviews, and checkpoint; do not commit.

## Round 2 review

- [ ] Non-author reruns Round 2 commands and verifies PAT direct-only policy, anonymous web preservation, central types defined once, saved/env/keyless migration semantics, symlink targets untouched, read modes enforced, and disjoint ownership.
- [ ] Repair and rereview every finding before central interfaces freeze.

---

# Round 3 — Independent CLI producers

Tasks 6–8 consume Task 5 and run in parallel with disjoint files. Task 8 exclusively owns CLI manifests/lockfile.

## Task 6: Account register/touch/logout and `ensureRegisteredSession`

**Files:**
- Create: `cli/src/auth/account-client.ts`, `cli/src/auth/account-client.test.ts`
- Create: `cli/src/auth/logout.ts`, `cli/src/auth/logout.test.ts`
- Modify: `cli/src/auth/login.ts`, `cli/src/auth/login.test.ts`
- Modify: `cli/src/auth/config.ts`, `cli/src/auth/config.test.ts`
- Consume only: Task 5 token-store exports

**Produced Interfaces:**

```ts
export type CliDeviceMetadata = { readonly deviceName: string; readonly appVersion?: string }
export const ensureRegisteredSession: (credential: Extract<ResolvedAccountCredential, { type: 'session' }>, metadata: CliDeviceMetadata, fetchFn?: AccountFetch) => Promise<Extract<ResolvedAccountCredential, { type: 'session' }>>
export type AccountActionDependencies = { readonly backendUrl: string; readonly metadata: CliDeviceMetadata; readonly fetchFn?: AccountFetch; readonly loadAuth: () => Promise<CliAuth | null>; readonly storeAuth: (auth: CliAuth) => Promise<void>; readonly clearAuth: () => Promise<void>; readonly patToken?: string }
export const createAccountActions: (dependencies: AccountActionDependencies) => AccountActions
```

- [ ] Add RED register/touch tests for exact bodyless URL/headers, first migrated-legacy use, idempotent startup touch, unexpired session success, generic 401, `DEVICE_DISCONNECTED`, one-time ID/cache rotation, and secure-origin checks.
- [ ] Run `(cd cli && bun test src/auth/account-client.test.ts --timeout 5000)`; expect missing producer RED.
- [ ] Implement `ensureRegisteredSession`: PAT is excluded by type, session calls `PUT /account/devices/cli`, successful touch persists `registered`, generic 401 clears only bearer to `authentication-required`, revoked tombstone rotates ID/cache and retries exactly once.
- [ ] Add RED login tests with a fake `DeviceGrantPresentation`: web grant always runs even with PAT, `showVerification` receives exact verification URL/user code/optional QR block, statuses are waiting then success/error, registration succeeds before success, and failed registration does not enable managed inference.
- [ ] Run `(cd cli && bun test src/auth/login.test.ts --timeout 5000)`; expect current PAT short-circuit RED.
- [ ] Implement `createAccountActions`; its bound login/logout methods accept `DeviceGrantPresentation` and never raw console callbacks. Login is web-only and reuses retained installation state when authentication is required.
- [ ] Add RED logout tests: 204 clears whole install; authoritative 401 clears bearer only and retains device/cache; network, 5xx, malformed, and aborted responses retain every byte; PAT-only returns external-management result without HTTP.
- [ ] Run `(cd cli && bun test src/auth/logout.test.ts --timeout 5000)`; expect missing logout RED.
- [ ] Implement remote-first logout with those exact state transitions and no automatic reauthentication/replay.
- [ ] Run Task 6 tests plus token-store/config tests and CLI typecheck; expect PASS.
- [ ] Centralize secure request headers/origin checks, complete both reviews, and checkpoint; do not commit.

## Task 7: Strict managed catalog client

**Files:** Create `cli/src/provider-runtime/catalog.ts`, `cli/src/provider-runtime/catalog.test.ts`

**Consumed Interfaces:** Task 1 `ManagedModels`; Task 5 `AccountFetch` and `ProviderRuntimeError`.

**Produced Interfaces:**

```ts
export const fetchManagedCatalog: ManagedCatalogLoader
export const resolveManagedModel: (catalog: ManagedModels, idOrSlug: string) => ManagedModel
```

- [ ] Add RED tests for schema/version/default/order, UUID/slug resolution, duplicate rejection, unknown transport rejection, and network errors.
- [ ] Feed Task 1's fixture-only future direct catalog through the parser and assert it resolves by UUID and slug with no parser branch for that slug.
- [ ] Add a RED payload containing unknown additive fields and private-looking fields; assert parsing succeeds and normalized output drops every unknown/private field.
- [ ] Run `(cd cli && bun test src/provider-runtime/catalog.test.ts --timeout 5000)`; expect module-not-found RED.
- [ ] Implement HTTPS/loopback fetch, explicit schema-v1 parsing, known-field reconstruction, additive-field sanitization, UUID/slug lookup, and stable errors. Never copy response objects wholesale.
- [ ] Run the catalog test and CLI typecheck; expect PASS.
- [ ] Confirm no URL/upstream/price/credential is accepted from catalog data, complete both reviews, and checkpoint; do not commit.

## Task 8: Pi dependency alignment and concrete `HarnessRuntime`

**Files:**
- Modify exclusively: `cli/package.json`, `cli/bun.lock`, `cli/bunfig.toml`
- Create: `cli/src/provider-runtime/harness-runtime.ts`, `cli/src/provider-runtime/harness-runtime.test.ts`
- Modify: `cli/src/agent/harness.ts`, `cli/src/agent/harness.test.ts`, `cli/src/agent/types.ts`

**Consumed Interfaces:** Task 5 `PreparedPiBinding` and `HarnessRuntime`.

**Produced Interface:**

```ts
export const createHarnessRuntime: (config: HarnessConfig, binding: PreparedPiBinding, session?: Session) => Promise<HarnessRuntime>
```

- [ ] Add RED dependency tests proving all CLI Pi packages equal 0.80.7 and Tinfoil is present.
- [ ] Add RED runtime tests proving it owns one `AgentHarness`, one `MutableModels`, one active binding, and an internal `promptActive` boolean; concurrent prompt/switch/deactivate is rejected without relying on `harness.isIdle`.
- [ ] Add RED tests for narrow subscribe/tool-gate delegation, prompt error observation exactly once, attach/unsubscribe, successful switch ordering, atomic-persist rollback, provider detachment, transactional deactivation, abort, and idempotent disposal. The credential-only `forceReplace:true` case must replace the active same-provider closure while leaving exactly one model entry in `MutableModels`; deactivation persistence failure restores the binding for profile removal but remains deactivated after irreversible account logout.
- [ ] Run `(cd cli && bun test src/provider-runtime/harness-runtime.test.ts src/agent/harness.test.ts --timeout 5000)`; expect version/runtime RED.
- [ ] Run `cd cli && bun add @earendil-works/pi-agent-core@0.80.7 @earendil-works/pi-ai@0.80.7 @earendil-works/pi-coding-agent@0.80.7 @earendil-works/pi-tui@0.80.7` and then `bun add tinfoil@latest`; only CLI manifest/lockfile may change.
- [ ] Refactor harness construction to accept a prepared binding, install it into a fresh mutable registry, and return `createHarnessRuntime` rather than raw provider inputs. Expose only narrow subscribe/tool-gate/prompt/wait/abort operations, not the raw harness.
- [ ] In `createHarnessRuntime`, call `binding.attach(harness)` once, retain its unsubscribe, attach a new binding before commit, and unsubscribe the old binding only after successful switch; rollback restores the old attachment.
- [ ] Implement `prompt`: set `promptActive`, call harness prompt/wait, call active binding `observePromptError` on error, clear the flag in `finally`; `switchBinding` waits for idle and rejects while active.
- [ ] Implement switch/deactivate/dispose as the sole live transaction owner. A switch retains the old binding until the atomic persistence callback succeeds, so no inverse config reconstruction exists. Deactivation applies the explicit failure mode. Router/manager never persist a live switch/deactivation directly.
- [ ] Run Task 8 tests, CLI typecheck/build, and `./dist/thunderbolt --version`; expect PASS.
- [ ] Confirm one engine/registry/manifest owner, complete both reviews, and checkpoint; do not commit.

## Round 3 review

- [ ] Non-author verifies every parallel consumer imported only Task 5 types, migrated sessions touch before use, logout distinctions, sanitized catalog, prompt-active runtime ownership, exact Pi versions, latest Tinfoil install, and disjoint files.
- [ ] Repair and rereview before producer interfaces freeze.

---

# Round 4 — BYOK, direct, and confidential binding producers

Tasks 9–11 run in parallel. They consume only reviewed Round 1–3 interfaces and own disjoint files.

## Task 9: `createByokBinding` for every built-in and openai-compat profile

**Files:**
- Create: `cli/src/provider-runtime/byok.ts`, `cli/src/provider-runtime/byok.test.ts`
- Modify: `cli/src/agent/model.ts`, `cli/src/agent/model.test.ts`

**Consumed Interfaces:** Task 5 `ByokProfile`, `InvocationSelection`, `PreparedPiBinding`; Task 8 Pi types.

**Produced Interface:**

```ts
export const createByokBinding: (profile: ByokProfile, selection: InvocationSelection, environment: Readonly<Record<string, string | undefined>>, onStoredCredentialRejected: (providerId: string) => Promise<void>) => Promise<PreparedPiBinding>
```

- [ ] Add RED tests for every `builtinProviders` value, explicit flag key, dedicated environment key, stored key, keyless failure, multiple same-provider profiles with distinct provider IDs, and openai-compat endpoint scoping.
- [ ] Add RED dispatch tests proving a BYOK failure never invokes direct or Tinfoil producers.
- [ ] Run `(cd cli && bun test src/provider-runtime/byok.test.ts src/agent/model.test.ts --timeout 5000)`; expect missing producer RED.
- [ ] Implement precedence: explicit `selection.apiKey`, then dedicated environment credential, then profile stored key; for openai-compat, stored key is eligible only when effective URL equals saved URL.
- [ ] Clone/adapt Pi built-in provider/model metadata so provider ID equals stable profile ID; preserve public model ID and native web-search behavior. Build openai-compat with stable profile ID and effective URL.
- [ ] Set `credentialProvenance` to flag/environment/stored-byok, return no-op `attach`, and persist authentication-required only through `observePromptError` on stored-key 401/403. Flag/env errors never mutate config.
- [ ] Run Task 9 tests and CLI typecheck; expect PASS.
- [ ] Confirm all providers use one producer and no fallback chain, complete both reviews, and checkpoint; do not commit.

## Task 10: Managed direct binding producer

**Files:**
- Create: `cli/src/provider-runtime/direct.ts`, `cli/src/provider-runtime/direct.test.ts`
- Modify: `cli/src/agent/openai-compat-model.ts`, `cli/src/agent/openai-compat-model.test.ts`

**Consumed Interfaces:** Task 1 catalog; Task 5 credentials/binding; Task 8 Pi runtime types.

**Produced Interface:**

```ts
export const createManagedDirectBinding: (options: { readonly credential: ResolvedAccountCredential; readonly model: ManagedModel; readonly onStoredSessionRejected: () => Promise<void>; readonly fetchFn?: AccountFetch }) => Promise<PreparedPiBinding>
```

- [ ] Add RED tests proving session emits only Bearer, PAT emits only `x-api-key`, remote non-HTTPS is rejected while loopback HTTP works, and stored-session 401 invokes the injected rejection callback. Registration ordering is tested at the ProviderRuntime seam in Task 12.
- [ ] Bind the fixture-only future direct model and assert the generic public slug reaches Pi/OpenAI request construction without a slug condition.
- [ ] Add RED no-fallback tests: auth/quota/network/direct failure invokes no BYOK or Tinfoil producer and causes no second inference request.
- [ ] Run `(cd cli && bun test src/provider-runtime/direct.test.ts src/agent/openai-compat-model.test.ts --timeout 5000)`; expect missing producer/injected fetch RED.
- [ ] Generalize the CLI-owned OpenAI-compatible builder with provider ID, base URL, injected fetch, reasoning, context window, and image support; do not import root `node_modules` implementation.
- [ ] Implement session/PAT header replacement and catalog slug model. `observePromptError` marks stored session authentication-required on 401; PAT never falls back or mutates stored session.
- [ ] Return no-op `attach`; direct usage is backend-accounted. Run Task 10 tests, CLI typecheck/build; expect PASS.
- [ ] Confirm one auth wrapper and no catalog-directed origin, complete both reviews, and checkpoint; do not commit.

## Task 11: Tinfoil binding with real harness-terminal receipt seam

**Files:**
- Create: `cli/src/provider-runtime/tinfoil.ts`, `cli/src/provider-runtime/tinfoil.test.ts`
- Create: `cli/src/provider-runtime/usage-receipt.ts`, `cli/src/provider-runtime/usage-receipt.test.ts`
- Reference tests only: `src/ai/tinfoil-client.test.ts`, `src/ai/inference-usage-receipt.test.ts`

**Consumed Interfaces:** Task 1 confidential model; Task 5 session credential/binding; Task 8 `attach` lifecycle.

**Produced Interface:**

```ts
export const createTinfoilBinding: (options: { readonly credential: Extract<ResolvedAccountCredential, { type: 'session' }>; readonly model: ManagedModel; readonly onStoredSessionRejected: () => Promise<void>; readonly fetchFn?: AccountFetch }) => Promise<PreparedPiBinding>
```

- [ ] Add RED tests proving the session-only type/constructor rejects PAT before SecureClient construction and stored-session 401 invokes the injected rejection callback. Registration ordering is tested at the ProviderRuntime seam in Task 12.
- [ ] Add a RED real-EHBP fixture that captures `X-Inference-Usage-Receipt`, then emits an actual `AgentHarness` terminal `message_end`; assert prompt=`input+cacheRead+cacheWrite`, completion=`output`, total=`totalTokens`.
- [ ] Add RED tests for stream done without receipt, provider error after header, abort, disposal, sequential tool steps, concurrent bindings, three-second receipt timeout, and stale-state clearing.
- [ ] Run `(cd cli && bun test src/provider-runtime/tinfoil.test.ts src/provider-runtime/usage-receipt.test.ts --timeout 5000)`; expect missing producer/hook RED.
- [ ] Construct `SecureClient` with backend `/tinfoil` and the validated 64-hex cache secret; authenticate only the proxy hop with session Bearer and never expose the secret in headers/logs.
- [ ] Implement binding-level `attach(harness)`: subscribe to actual harness events, consume pending receipt only on terminal assistant `message_end`, submit to `/inference-usage/receipts`, and return unsubscribe. Provider stream only captures headers/done/error; it does not claim to receive harness events.
- [ ] Clear receipt on stream error/done-without-message, harness abort/error, unsubscribe, and dispose. Receipt failure is diagnostic and never alters answer/model or retries inference.
- [ ] `observePromptError` marks stored session authentication-required on 401; return idempotent SecureClient/reset/dispose cleanup.
- [ ] Run Task 11 tests, CLI typecheck/build; expect PASS.
- [ ] Confirm per-binding state and real terminal seam, complete both reviews, and checkpoint; do not commit.

## Round 4 review

- [ ] Non-author reruns all producer tests and verifies complete BYOK provider coverage, key precedence/endpoint scoping, no-fallback producer isolation, direct PAT-only support, real Tinfoil terminal receipt seam, and disjoint ownership. Register-before-managed is deferred to the Round 5 ProviderRuntime review.
- [ ] Repair and rereview before producer interfaces freeze.

---

# Round 5 — ProviderRuntime and pure command decisions

Tasks 12 and 13 run in parallel. They consume frozen producers and central types; neither owns UI/run/ACP integration files.

## Task 12: ProviderRuntime dispatch, registration gate, provider manager, and prompt-error callbacks

**Files:**
- Create: `cli/src/provider-runtime/runtime.ts`, `cli/src/provider-runtime/runtime.test.ts`
- Create: `cli/src/provider-runtime/manager.ts`, `cli/src/provider-runtime/manager.test.ts`
- Modify: `cli/src/config/wizard.ts`, `cli/src/config/wizard.test.ts`
- Modify: `cli/src/config/model-listing.ts`, `cli/src/config/model-listing.test.ts`

**Consumed Interfaces:** Task 5 central types; Task 6 `AccountActions`/`ensureRegisteredSession`; Task 7 injected catalog loader; Tasks 9, 10, 11 binding producers.

**Produced Interface:**

```ts
export type ProviderRuntimeDependencies = {
  readonly loadConfig: typeof loadConfig
  readonly saveConfig: typeof saveConfig
  readonly resolveAccountCredential: typeof resolveAccountCredential
  readonly accountActions: AccountActions
  readonly loadCatalog: ManagedCatalogLoader
  readonly ensureRegisteredSession: typeof ensureRegisteredSession
  readonly metadata: CliDeviceMetadata
  readonly createByokBinding: typeof createByokBinding
  readonly createManagedDirectBinding: typeof createManagedDirectBinding
  readonly createTinfoilBinding: typeof createTinfoilBinding
  readonly environment: Readonly<Record<string, string | undefined>>
}
export const createProviderRuntime: (dependencies: ProviderRuntimeDependencies) => Promise<ProviderRuntime>
export const runProviderManager: (io: ProviderManagerIO, runtime: ProviderRuntime, mode: ProviderManagerMode) => Promise<CommandOutcome>
```

- [ ] Add RED tests for multiple same-provider profiles, stable ID/unique shorthand, model ownership, persisted last-known status, all four non-persisting overrides, endpoint scoping, and structural Thunderbolt snapshot.
- [ ] Add RED dispatch tests with counters: BYOK selection invokes only `createByokBinding`; managed direct only direct; GLM only Tinfoil; every failure invokes no alternate producer.
- [ ] Add the fixture-only future direct entry to the runtime catalog test and assert generic dispatch invokes `createManagedDirectBinding` once with no model-specific runtime branch.
- [ ] Add RED tests proving every session-backed managed prepare calls injected `ensureRegisteredSession` first, legacy first use registers, repeated startup prepare touches idempotently, PAT direct skips, and PAT GLM returns `WEB_LOGIN_REQUIRED` before a producer.
- [ ] Add RED legacy-runtime cases for stored-key built-in, environment-key built-in, stored-key openai-compat, and keyless profiles. Each starts active and authentication-required without onboarding; its first explicit prepare is attempted, successful validation persists authenticated, and credential failure remains active with actionable authentication-required state.
- [ ] Run `(cd cli && bun test src/provider-runtime/runtime.test.ts --timeout 5000)`; expect missing runtime RED.
- [ ] Implement immutable snapshots and atomic `manage` persistence primitives: compute the next full config, write it, then publish in-memory state; a failed write leaves both persisted and in-memory config unchanged. `select-model` only persists when called by HarnessRuntime's transaction callback; manager/router never call it before live activation.
- [ ] Implement `prepare`: resolve profile/unique shorthand, apply overrides, load catalog only through injected `loadCatalog`, resolve credential, ensure session registration for managed session use, then dispatch exactly one producer. Runtime imports no network/catalog implementation.
- [ ] Inject rejection callbacks into producers: stored BYOK 401/403 persists that profile as authentication-required; stored session 401 persists bearer null/registration authentication-required; flag/environment/PAT errors mutate no file.
- [ ] Add RED manager tests with scripted `ProviderManagerIO`: `/login` passes IO as `DeviceGrantPresentation` to bound account actions and displays verification URL, user code, waiting, success, and error; `/logout` passes the same adapter.
- [ ] Add the exact deferred-outcome RED matrix:

```ts
expect(providerSwitch).toEqual({ kind: 'switch', selection: { providerId: byokId }, persist: { type: 'use', providerId: byokId }, forceReplace: false })
expect(modelSwitch).toEqual({ kind: 'switch', selection: { providerId: byokId, model: 'new-model' }, persist: { type: 'select-model', providerId: byokId, model: 'new-model' }, forceReplace: false })
expect(activeRepair).toEqual({ kind: 'switch', selection: { providerId: byokId, apiKey: 'replacement-key' }, persist: { type: 'save-byok', profile: repairedProfile }, forceReplace: true })
expect(activeThunderboltLogin).toEqual({ kind: 'switch', selection: { providerId: 'thunderbolt' }, persist: { type: 'use', providerId: 'thunderbolt' }, forceReplace: true })
expect(activeThunderboltLogout).toEqual({ kind: 'deactivate', persist: { type: 'clear-active' } })
expect(byokActiveLogout).toEqual({ kind: 'handled' })
expect(activeRemoval).toEqual({ kind: 'deactivate', persist: { type: 'remove-byok', providerId: byokId } })
expect(inactiveRemoval).toEqual({ kind: 'handled' })
expect(runtimeManage).toHaveBeenCalledWith({ type: 'remove-byok', providerId: inactiveByokId })
```
- [ ] Run `(cd cli && bun test src/provider-runtime/manager.test.ts src/config/wizard.test.ts src/config/model-listing.test.ts --timeout 5000)`; expect old wizard behavior RED.
- [ ] Implement manager paths. `runProviderManager` is the sole presentation/controller caller that emits `runtime.manage({type:'login'|'logout',presentation:io})`; `ProviderRuntime.manage` invokes only its injected bound `AccountActions`, which own network/state. For switch/deactivate outcomes, manager returns the deferred persistence command and does not call it. Inactive removal may persist immediately and return handled. Logout deactivates only when Thunderbolt is active; BYOK remains live. BYOK validation marks authenticated only after first explicit successful preparation/repair; every migrated profile starts authentication-required, stays active, and does not reopen first-run automatically.
- [ ] Run all Task 12 tests and CLI typecheck; expect PASS.
- [ ] Confirm three-operation external runtime, injected registration/producer seams, and no duplicate switch persistence, complete both reviews, and checkpoint; do not commit.

## Task 13: Syntactic parser and pure command router outcomes

**Files:**
- Create: `cli/src/provider-runtime/commands.ts`, `cli/src/provider-runtime/commands.test.ts`
- Modify: `cli/src/cli.ts`, `cli/src/cli.test.ts`
- Modify: `cli/src/agent/types.ts` only for `RunConfig`/`ServeConfig` selection shapes

**Consumed Interfaces:** Task 5 `InvocationSelection`, `CommandOutcome`, `ProviderRuntime`, and `ProviderManagerRunner`.

**Produced Interfaces:**

```ts
export type RunConfig = HarnessConfig & ({ readonly mode: 'oneshot'; readonly prompt: string; readonly selection: InvocationSelection } | { readonly mode: 'repl'; readonly noTui: boolean; readonly selection: InvocationSelection })
export type ServeConfig = HarnessConfig & { readonly selection: InvocationSelection }
export const createCommandRouter: (runtime: ProviderRuntime, manager: ProviderManagerRunner) => { readonly handle: (text: string) => Promise<CommandOutcome> }
```

- [ ] Add RED parser tests: free-string profile ID/shorthand is stored without resolution, all overrides are optional/non-persisting, `logout` parses, `agent` aliases primary, and bridges remain unchanged.
- [ ] In the same owned test file, add the final RED help contract: `/providers`, `/models`, `/login`, and `/logout` are documented; `--api-key` remains listed; no key-bearing example appears; PAT is described as direct-only; confidential GLM directs the user to web login.
- [ ] Run `(cd cli && bun test src/cli.test.ts --timeout 5000)`; expect parser/logout/help-contract RED.
- [ ] Make parsing syntactic only, move provider/model/key/URL resolution out of `cli.ts`, and update production help in `cli.ts` until the complete owned help contract passes.
- [ ] Add RED router tests for exact outcomes:

```ts
expect(await router.handle('/models')).toEqual({ kind: 'switch', selection: { providerId: 'thunderbolt', model: 'opus-5' }, persist: { type: 'select-model', providerId: 'thunderbolt', model: 'opus-5' }, forceReplace: false })
expect(await router.handle('/logout')).toEqual({ kind: 'deactivate', persist: { type: 'clear-active' } })
expect(await router.handle('/other text')).toEqual({ kind: 'forward', text: '/other text' })
```

- [ ] Run `(cd cli && bun test src/provider-runtime/commands.test.ts --timeout 5000)`; expect missing router RED.
- [ ] Implement reserved command interception. `/providers` and `/models` return manager outcomes; `/login` returns handled unless it changes active selection; `/logout` returns deactivate after remote success; unknown text returns forward unchanged; exit/quit returns exit.
- [ ] Run Task 13 tests and CLI typecheck; expect PASS.
- [ ] Confirm no UI, harness, persistence transaction, or credential logic entered these files, complete both reviews, and checkpoint; do not commit.

## Round 5 review

- [ ] Non-author verifies register-before-session-managed, no-fallback producer counters, one prompt-error mutation path, migrated status semantics, explicit router outcomes, syntactic parsing, and no duplicated persistence transaction.
- [ ] Repair and rereview before runtime/router freeze.

---

# Round 6 — Plain/TUI bootstrap and ACP consumers

Tasks 14 and 15 run in parallel after Round 5 freeze. Neither edits `cli/src/index.ts`; Task 16 wires their reviewed signatures afterward.

## Task 14: Pre-harness first-run bootstrap and plain/TUI run integration

**Files:**
- Modify: `cli/src/agent/run.ts`, `cli/src/agent/run.test.ts`
- Modify: `cli/src/ui/prompt.ts`, `cli/src/ui/tui.ts`, `cli/src/ui/render.ts`
- Create: `cli/src/ui/provider-manager.ts`, `cli/src/ui/provider-manager.test.ts`

**Consumed Interfaces:** Tasks 5, 8, 12, 13 frozen types/runtime/router/manager.

**Produced Interfaces:**

```ts
export const bootstrapBeforeHarness: (config: RunConfig, runtime: ProviderRuntime, io: ProviderManagerIO, terminal: { readonly interactive: boolean }) => Promise<{ readonly config: RunConfig; readonly binding: PreparedPiBinding }>
export const applyCommandOutcome: (outcome: CommandOutcome, runtime: ProviderRuntime, harness: HarnessRuntime) => Promise<InvocationSelection | null>
export const createPlainProviderManagerIO: (terminal: SetupWizardIO) => ProviderManagerIO
export const createTuiProviderManagerIO: (tui: TUI, scrollback: Container, editor: Editor) => ProviderManagerIO
export const runAgent: (config: RunConfig, runtime: ProviderRuntime) => Promise<void>
```

- [ ] Add RED first-run tests: plain terminal onboarding completes before `createHarnessRuntime`; TUI constructor is not called during onboarding; non-TTY without usable profile errors; successful account/BYOK+model selection builds once; original one-shot prompt runs once after bootstrap.
- [ ] Add a RED first-run transaction test where the manager returns a switch outcome: `runtime.prepare(outcome.selection)` runs once, then `runtime.manage(outcome.persist)` runs exactly once before `createHarnessRuntime`. When persistence rejects, the prepared binding is disposed exactly once and neither harness construction nor the original prompt runs.
- [ ] Add a RED migration bootstrap test proving an active migrated environment/keyless profile marked authentication-required does not reopen first-run automatically; preparation surfaces repair guidance instead.
- [ ] Add RED failure tests proving failed login/prepare does not construct harness or replay prompt; later interactive `/login` does not replay the failed prompt.
- [ ] Add RED adapter/ownership tests that drive `/login` and `/logout` through `runProviderManager` with scripted plain IO and with TUI IO. Both render the exact verification URL/user code and waiting/success/error states; optional QR is rendered as a text/block; while TUI is active, a stdout spy receives no direct write.
- [ ] Run `(cd cli && bun test src/agent/run.test.ts src/ui/provider-manager.test.ts --timeout 5000)`; expect current build-before-wizard/TUI behavior RED.
- [ ] Implement `ProviderManagerIO` plain adapter from existing hidden-input readline. `bootstrapBeforeHarness` uses this plain adapter before any harness/TUI object and calls first-run manager only when no usable active provider. For a switch outcome it prepares one binding, applies `runtime.manage(outcome.persist)` exactly once, and only then returns the binding for harness construction; persistence failure disposes the binding and exits without a harness or prompt.
- [ ] Run `(cd cli && bun test src/agent/run.test.ts --timeout 5000)` again; expect the first-run persistence-order and cleanup tests to PASS.
- [ ] Implement TUI manager adapter for post-harness `/providers`, `/models`, `/login`, and `/logout`, using `SelectList`, focused editor, and scrollback components for every device-grant presentation operation. It never calls console/stdout while TUI owns the terminal. No pre-harness TUI shell is created.
- [ ] Adapt plain/TUI renderer and permission wiring to `HarnessRuntime.subscribe` and `registerToolCallGate`; do not expose or cast back to raw `AgentHarness`.
- [ ] Add RED outcome-application tests: every switch prepares once and calls `HarnessRuntime.switchBinding` exactly once with atomic `runtime.manage(outcome.persist)` and `forceReplace`; deactivate calls transactional `harness.deactivate` once. `clear-active` uses `remain-deactivated` because remote logout is irreversible, while `remove-byok` uses `restore-binding`; handled does nothing and forward prompts once.
- [ ] Run `(cd cli && bun test src/provider-runtime/commands.test.ts src/agent/run.test.ts --timeout 5000)`; expect missing application logic RED.
- [ ] Implement `applyCommandOutcome`; HarnessRuntime is the sole live/persistence transaction owner. For switch, prepare first, then pass one deferred atomic persistence callback plus `forceReplace` to `switchBinding`. For deactivate, pass the deferred command once and derive the explicit failure mode from `clear-active` versus `remove-byok`. Never reconstruct a prior config from a lossy snapshot, and never restore a remotely revoked Thunderbolt binding.
- [ ] Route all plain/TUI prompts through `HarnessRuntime.prompt`, so the binding's shared `observePromptError` path runs exactly once. Interactive errors render and remain usable; one-shot exits nonzero.
- [ ] Run `(cd cli && bun test src/agent/run.test.ts src/ui/provider-manager.test.ts src/provider-runtime/commands.test.ts src/cli.test.ts --timeout 5000)`, `(cd cli && bun run typecheck)`, `(cd cli && bun run build)`, `(cd cli && ./dist/thunderbolt --version)`, and `(cd cli && ./dist/thunderbolt --help >/dev/null)`; expect PASS.
- [ ] Confirm no index edit, no pre-harness TUI, no replay, and one transaction owner; complete both reviews and checkpoint; do not commit.

## Task 15: ACP startup probe and independent per-session bindings

**Files:**
- Modify: `cli/src/acp/serve.ts`, `cli/src/acp/harness-agent.ts`
- Modify: `cli/src/acp/harness-agent.test.ts`
- Create: `cli/src/acp/serve.test.ts`, `cli/src/provider-runtime/parity.test.ts`
- Test only: `cli/src/acp/harness-to-acp.test.ts`, `cli/src/acp/session-store.test.ts`
- Do not modify: `cli/src/index.ts`

**Consumed Interfaces:** Tasks 5, 8, 12 frozen `ProviderRuntime`, `HarnessRuntime`, and selection types.

**Produced Interfaces:**

```ts
export const runAcpServe: (config: ServeConfig, runtime: ProviderRuntime) => Promise<void>
export const createHarnessAgent: (connection: AgentSideConnection, config: ServeConfig, store: SessionStore, runtime: ProviderRuntime) => Agent
```

- [ ] Add RED startup tests: missing/ambiguous profile, missing model, invalid config, and auth-required fail before `ndJsonStream`/`AgentSideConnection`; probe binding is disposed; no manager/login/UI call occurs.
- [ ] Run `(cd cli && bun test src/acp/serve.test.ts --timeout 5000)`; expect current stdio-start-before-validation RED.
- [ ] Implement startup probe: `runtime.prepare(config.selection)`, then immediately `dispose`; only after success construct the stdio stream/server.
- [ ] Add RED per-session tests: each new/resume calls `runtime.prepare` independently, constructs its own HarnessRuntime/Tinfoil state, and disposes it; two concurrent sessions do not share receipts.
- [ ] Add RED prompt tests: direct and ACP both use HarnessRuntime prompt-error observation; stored BYOK/session 401 persists auth-required, flag/env/PAT does not mutate; prompt error leaves ACP server available and no replay/fallback occurs.
- [ ] Run `(cd cli && bun test src/provider-runtime/parity.test.ts src/acp/harness-agent.test.ts src/acp/serve.test.ts --timeout 5000)`; expect raw-provider/per-session RED.
- [ ] Replace raw provider/model/key/base URL copying with `config.selection`; prepare/build a HarnessRuntime per ACP session and adapt its prompt/wait/abort/subscribe behavior without opening UI.
- [ ] Run `(cd cli && bun test src/provider-runtime/parity.test.ts src/acp/harness-agent.test.ts src/acp/serve.test.ts src/acp/harness-to-acp.test.ts src/acp/session-store.test.ts --timeout 5000)`, `(cd cli && bun run typecheck)`, and `(cd cli && bun run build)`; expect PASS.
- [ ] Confirm startup probe disposal, independent sessions, shared error observation, and no index edit; complete both reviews and checkpoint; do not commit.

## Round 6 review

- [ ] Non-author verifies first-run precedes all harness/TUI construction, one-shot original prompt runs once, post-failure login never replays, explicit outcomes drive HarnessRuntime, neither task edits index, ACP validates before stdio and prepares independently, and prompt-error mutation is shared.
- [ ] Repair and rereview before acceptance/docs work.

---

# Round 7 — Sole entrypoint wiring

## Task 16: Wire reviewed direct and ACP consumers in `cli/src/index.ts`

**Files:** Modify exclusively `cli/src/index.ts`; extend test only `cli/src/cli.test.ts`.

**Consumed Interfaces:** Task 12 `ProviderRuntime`/`runProviderManager`; Task 13 parsed actions; Task 14 `runAgent`/`createPlainProviderManagerIO`; Task 15 `runAcpServe`.

- [ ] Add RED dispatch tests proving index creates one ProviderRuntime, routes run to `runAgent(config,runtime)`, ACP serve to `runAcpServe(config,runtime)`, and routes standalone login/logout through `runProviderManager` with Task 14's plain IO. With no HarnessRuntime, index applies the returned deferred command exactly once through atomic `runtime.manage`; bridge/connect/iroh branches receive no ProviderRuntime behavior change.
- [ ] Run `(cd cli && bun test src/cli.test.ts --timeout 5000)`; expect old one-argument run/ACP dispatch RED.
- [ ] Wire the reviewed signatures only. Standalone login/logout select manager modes `login`/`logout`; they never bypass manager presentation ownership. Do not implement provider, UI, bootstrap, or ACP behavior in index.
- [ ] Run `(cd cli && bun test src/cli.test.ts src/agent/run.test.ts src/acp/serve.test.ts --timeout 5000)`, `(cd cli && bun run typecheck)`, `(cd cli && bun run build)`, `(cd cli && ./dist/thunderbolt --version)`, and `(cd cli && ./dist/thunderbolt --help >/dev/null)`; expect PASS.
- [ ] Confirm index is a thin dispatcher with no duplicate persistence/auth logic, complete both reviews, and checkpoint; do not commit.

## Round 7 review

- [ ] Non-author verifies sole index ownership, one runtime instance, exact direct/ACP injection, and unchanged external bridge dispatch.
- [ ] Repair and rereview before acceptance/docs work.

---

# Round 8 — Acceptance coverage and release/rollout contracts

Tasks 17 and 18 run in parallel. Task 17 owns docs/workflows/package test wiring; Task 18 owns test files only.

## Task 17: Docs, CI filters, backend image triggers, and native release checks

**Files:**
- Modify: `cli/README.md`, `backend/docs/pat-lifecycle.md`, `docs/architecture/powersync-account-devices.md`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/cli-release.yml`, `.github/workflows/images-publish.yml`
- Create: `.github/scripts/cli-ci-paths.test.ts` (superseded: direct workflow configuration and CI command verification)
- Modify: `package.json` root `test` script so the new CI contract test is executed by `bun run test`

**Consumed Interfaces:** Final commands, catalog paths, PAT/session policy, and rollout order.

- [ ] Add a RED CI contract test asserting the expected CLI-filter YAML includes `shared/managed-models.test-fixtures.ts` alongside shared catalog/default/receipt inputs, the backend image filter includes shared runtime inputs, CLI CI invokes typecheck/test/build, and root `package.json` configured `test` script names this test file.
- [ ] Run `bun test .github/scripts/cli-ci-paths.test.ts --timeout 5000`; expect missing test/filter/build RED. (Superseded: direct workflow configuration and CI command verification.)
- [ ] Add the test to the existing explicit root `test` command. Add `shared/managed-models.ts`, `shared/managed-models.test.ts`, `shared/managed-models.test-fixtures.ts`, `shared/defaults/models.ts`, `shared/inference-usage.ts`, `backend/src/api/config.ts`, and `package.json` to both the CI contract's expected CLI-filter YAML and the actual CLI filter. Add shared managed-model/default/receipt paths to the backend image filter. Correct the inaccurate “CLI has no shared imports” comment.
- [ ] Add host CLI build and `--version`/`--help` smoke to CLI CI; add no CLI lint/Oxlint.
- [ ] Update each existing native release matrix leg to run frozen install, typecheck, tests including the real Tinfoil fixture, native compile, then execute that native artifact's `--version` and `--help`. Do not replace native runners with `build:all`.
- [ ] Update user/operator docs for account-first onboarding, profiles, commands, PAT direct-only, GLM web login, revocation, no CLI sync, and backend-first rollout. Never publish private upstream/price/credential data.
- [ ] Reverify Task 13's already-reviewed help without editing it: run `(cd cli && bun test src/cli.test.ts --timeout 5000)`, `(cd cli && bun run build)`, and `(cd cli && ./dist/thunderbolt --help >/dev/null)`; expect PASS.
- [ ] Run `bun run test`, `bun run type-check`, `bun run lint`, `(cd cli && bun run test)`, `(cd cli && bun run typecheck)`, `(cd cli && bun run build)`, `(cd cli && ./dist/thunderbolt --version)`, `(cd cli && ./dist/thunderbolt --help >/dev/null)`, and `git diff --check`; expect PASS.
- [ ] Reuse existing workflow structure, complete both reviews, and checkpoint; do not commit.

## Task 18: Cross-stack acceptance and regression tests only

**Files:**
- Create test only: `backend/src/inference/cli-device.integration.test.ts`
- Create test only: `cli/src/provider-runtime/account-flow.integration.test.ts`, `cli/src/provider-runtime/no-fallback.integration.test.ts`
- Extend test only: `backend/src/auth/auth-anonymous.test.ts`, `backend/src/inference/managed-usage.integration.test.ts`, `src/settings/devices.test.tsx`
- Do not edit production files.

**Consumed Interfaces:** All reviewed producers and consumers from Tasks 1–15.

- [ ] Add backend acceptance coverage for real device-grant bearer → CLI register → direct inference → trusted app remote revoke → bearer 401, with one provider request total.
- [ ] Add anonymous regression coverage: anonymous web direct/confidential quotas remain; anonymous CLI registration fails.
- [ ] Add CLI acceptance coverage for first legacy registration/touch, generic session 401 retaining installation, same-ID relink, revoked tombstone one-time rotation, confirmed logout/new-ID login, PAT direct success, PAT GLM `WEB_LOGIN_REQUIRED`, and no fallback/replay.
- [ ] Add one acceptance matrix row that sends Task 1's fixture-only schema-v1 future direct model through shared normalization, CLI parsing, generic direct binding, and ProviderRuntime dispatch, with no model-specific branch at any seam.
- [ ] Run the new backend and CLI tests immediately. They may PASS because all production producers are already reviewed; failure is a legitimate integration finding, not an artificial TDD requirement.

```bash
(cd backend && bun test src/inference/cli-device.integration.test.ts src/auth/auth-anonymous.test.ts src/inference/managed-usage.integration.test.ts --timeout 5000)
(cd cli && bun test src/provider-runtime/account-flow.integration.test.ts src/provider-runtime/no-fallback.integration.test.ts --timeout 5000)
```

- [ ] Route failures to the owning production task; this task remains test-only. Repairs receive both task reviews.
- [ ] Run focused existing-client regressions: `bun test src/settings/devices.test.tsx src/components/device-approval.test.tsx --timeout 5000` and `(cd backend && bun test src/api/powersync.test.ts src/api/encryption.test.ts src/tinfoil/routes.test.ts src/inference/routes.test.ts --timeout 5000)`.
- [ ] Run `(cd backend && bun run type-check)`, `(cd cli && bun run typecheck)`, and `git diff --check`; expect PASS.
- [ ] Remove duplicated fixture setup only, complete both reviews, and checkpoint; do not commit.

## Round 8 review

- [ ] Non-author maps every spec acceptance criterion to passing coverage, verifies Task 18 is test-only, confirms configured root test executes the CI contract test, reruns CLI typecheck/test/build and compiled smoke, and validates native/backend-image rollout filters.
- [ ] Repair and rereview every finding before final verification.

---

## Task 19: Final independent verification

**Round:** Final, serial, no edits

**Files:** Inspect all reviewed feature files; modify none.

**Consumed Interfaces:** Complete reviewed system.

- [ ] Run complete CLI verification:

```bash
(cd cli && bun install --frozen-lockfile)
(cd cli && bun run test)
(cd cli && bun run typecheck)
(cd cli && bun run build)
(cd cli && ./dist/thunderbolt --version)
(cd cli && ./dist/thunderbolt --help >/dev/null)
```

- [ ] Run backend/shared verification:

```bash
(cd backend && bun install --frozen-lockfile)
(cd backend && bun run type-check)
(cd backend && bun run lint)
bun run test:backend
bun test shared/managed-models.test.ts shared/inference-usage.test.ts .github/scripts/cli-ci-paths.test.ts --timeout 5000 # superseded: direct workflow configuration and CI command verification
```

- [ ] Run existing-client verification:

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test
bun run build
```

- [ ] Verify scope/schema:

```bash
git status --short
git diff --check
git diff --stat
git diff -- backend/drizzle backend/drizzle/meta/_journal.json
```

Expected: all commands PASS, no SQL/snapshot/journal change for `device_type`, no local research artifact, and no unrelated diff.

- [ ] Dispatch final non-author spec reviewer and separate security/code-quality reviewer. Delegate and rereview every finding.
- [ ] Record final command output, changed files, and diff; do not commit. `/thunderpush` remains outside this plan.

---

## Spec coverage matrix

| Requirement | Tasks |
| --- | --- |
| Shared public catalog, private direct mapping, current models, future direct | 1, 7, 10, 12, 18 |
| Tinfoil PAT rejection and GLM receipt policy | 4, 11, 18 |
| Atomic real-session CLI device registration/touch/logout/revoke | 2, 6, 12, 18 |
| Reserved CLI namespace, no PowerSync CLI, type guards | 2, 3, 18 |
| Conservative unknown UI and anonymous real-login gate | 3, 18 |
| Versioned config/auth, secure symlink-safe state, migrations | 5, 18 |
| Saved/env/keyless/openai-compat legacy semantics | 5, 9, 12, 18 |
| Account login/logout, device-grant presentation, expired session, relink, revoked rotation | 6, 12, 14, 18 |
| Concrete Pi HarnessRuntime and exact versions | 8, 19 |
| Complete BYOK producer and no fallback | 9, 12, 18 |
| Direct session/PAT producer and secure origins | 10, 12, 18 |
| Session-only Tinfoil, cache secret, actual message-end receipt seam | 11, 18 |
| ProviderRuntime registration gate and shared prompt-error mutation | 12, 14, 15, 18 |
| Explicit command outcomes and single switch transaction owner | 8, 12, 13, 14 |
| Plain pre-harness onboarding, TUI/plain parity, no replay | 14, 18 |
| ACP startup probe, independent sessions, no UI | 15, 18 |
| Sole entrypoint wiring | 16, 18 |
| PAT direct-only compatibility and bridge preservation | 4, 5, 6, 10, 12, 15, 18 |
| Backend-first/old-client-safe rollout, CI/native builds | 1–4, 17, 19 |
| Delegated task reviews and round reviews | Global gates and every round |

## Plan self-review

- **Exact interfaces:** PASS. Central CLI types, including `AccountActions`, `ProviderManagerIO`, deferred `CommandOutcome`, and `HarnessRuntime`, are defined once in Task 5; each later task lists only produced or consumed interfaces.
- **Producer ordering:** PASS. Task 5 freezes account/presentation/transaction types before consumers; Task 6 produces bound account actions and Task 7 the catalog loader before Task 12 injects both; Tasks 6–8 precede binding producers; Tasks 9–11 precede ProviderRuntime; Tasks 12–13 precede UI/ACP consumers.
- **Parallel ownership:** PASS. Every parallel round has disjoint production files; `cli/src/index.ts` has one owner, Task 16.
- **TDD ordering:** PASS. Every production behavior task lists concrete RED tests and commands before production steps. Task 18 is explicitly acceptance-only.
- **Help ownership:** PASS. Task 13 alone changes production help and owns its final assertions; Task 17 only reruns the reviewed contract.
- **Command coverage:** PASS. Missing PAT-Tinfoil, receipt, anonymous approval, expired bearer, symlink directory, typecheck, build, and compiled smoke commands are present.
- **Constraint coverage:** PASS. Bun only, no bare root test, no Oxlint, no commits/push, no extra worktree, no SQL, no local research artifact, Pi sole engine, exact Pi alignment, and Tinfoil latest are explicit.
- **Markdown integrity:** PASS. Code fences and checkboxes are balanced; no incomplete markers or undefined central interfaces remain.

## Execution handoff

Execution mode is already chosen: **subagent-driven development**. The repaired plan contains **20 tasks (Task 0 through Task 19) across eight coding rounds, plus preflight and final verification**. Begin by delegating Task 0 and enforce every task/round gate without asking the user another execution question.

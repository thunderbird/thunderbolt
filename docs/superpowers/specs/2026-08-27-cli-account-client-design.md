# Thunderbolt CLI account client design

## Summary

`thunderbolt` becomes a first-class account-backed coding client while retaining multiple BYOK profiles. Pi remains the sole agent engine. Harnesses, tools, permissions, working directories, and sessions stay local; the Thunderbolt backend provides only authenticated inference, the managed-model catalog, usage accounting, and CLI-device lifecycle. The CLI has no PowerSync client and does not sync chats, settings, provider profiles, secrets, tools, or sessions. Anonymous web inference and its existing quotas remain unchanged, but the CLI account path requires a real account.

Direct CLI and built-in `acp serve` use the same provider runtime and Pi bindings. External ACP/MCP WSS and iroh bridges remain separate and unchanged.

## Current state and evidence

`cli/src/config/config.ts` persists one provider/model/key/URL tuple. `cli/src/cli.ts` resolves provider inputs during parsing, `cli/src/config/wizard.ts` overwrites that tuple, and `cli/src/agent/model.ts` constructs Pi providers directly. `cli/src/agent/harness.ts` consumes raw provider fields; `cli/src/acp/harness-agent.ts` duplicates them for ACP sessions.

Device-grant code exists under `cli/src/auth/`, but its bearer currently supports bridge account allowlisting rather than managed inference. `shared/defaults/models.ts` defines Opus 5, DeepSeek V4 Flash, and confidential GLM 5.2. `backend/src/api/config.ts` exposes defaults, `backend/src/inference/routes.ts` maps public direct slugs to private upstreams, and `backend/src/tinfoil/routes.ts` proxies encrypted traffic and issues usage receipts.

The CLI pins Pi 0.80.2 while the root pins 0.80.7. CLI and root Pi packages must use exactly the same version before the shared runtime behavior ships.

## Goals

- Make `thunderbolt` primary and retain `thunderbolt agent` as a compatibility alias.
- Recommend Thunderbolt account login on first run while retaining API-key providers.
- Keep a structural Thunderbolt account profile plus multiple BYOK profiles, including several profiles using the same provider type.
- Offer all managed models available in other Thunderbolt clients: Opus 5, DeepSeek V4 Flash, confidential GLM 5.2, and schema-compatible future direct models from `/v1/config`.
- Share provider/model/auth/error behavior between direct CLI and built-in ACP.
- Register and revoke a distinct CLI account device.

## Non-goals

- PowerSync or CLI data synchronization.
- Anonymous CLI account mode.
- A second agent engine, generic provider plugins, or runtime package loading.
- Keychain/keyring integration.
- Changes to external ACP/MCP bridge transports.
- Oxlint installation or configuration.

## User experience and commands

```text
thunderbolt [options] [prompt]
thunderbolt agent [options] [prompt]
thunderbolt config
thunderbolt login
thunderbolt logout
```

Interactive commands are `/providers`, `/models`, `/login`, and `/logout`. The shared TUI/plain command router intercepts known reserved commands. Unknown non-reserved slash input is passed unchanged to Pi for backward compatibility; the CLI does not interpret or promise resolution of that text.

The first interactive run without a usable active provider displays:

```text
Choose how to connect:
  1. Thunderbolt account (recommended)
  2. Provider API key
```

Account setup performs web device authorization, CLI-device registration, managed-catalog loading, and model selection. BYOK setup asks for provider, hidden key, connection fields, and upstream model. Non-TTY execution never opens the wizard.

`/providers` always shows `Thunderbolt — authenticated` or `Thunderbolt — not authenticated`, followed only by BYOK profiles the user added. `authenticated` means the credential successfully validated during add, repair, or login; merely opening the manager does not revalidate it. A later 401 changes the row to `authentication required`. The manager supports use, add, repair, remove, and Thunderbolt login. `thunderbolt config` opens the same manager. No removal or logout selects another profile automatically.

`/models` selects and persists the active provider's model. `--provider`, `--model`, `--api-key`, and `--base-url` are per-process overrides and never persist. `--provider` accepts a stable profile ID; provider/label shorthand works only when it matches exactly one profile, otherwise the CLI reports the matching IDs and requires an explicit choice. For Thunderbolt, `--model` accepts the public slug and resolves it to the catalog UUID. For BYOK, it is the upstream model ID. If `--base-url` changes an OpenAI-compatible profile's URL, its saved key is ineligible; only an explicit `--api-key` or the dedicated OpenAI-compatible environment key may be sent to the override URL.

The managed catalog is lazy. Runtime creation, `/providers`, `config`, logout, and the pre-authorization portion of login do not depend on `/v1/config`; the catalog loads only for managed `prepare`, `/models`, or post-login model selection.

`--api-key` remains compatibility-only because command-line arguments may appear in shell history or process listings. It is never persisted when used as an override, is centrally redacted from diagnostics and process displays, and is omitted from help examples.

`/login` and `thunderbolt login` always perform web login, including when `THUNDERBOLT_TOKEN` is set. The CLI warns that the environment PAT retains precedence until the user removes it. `/logout` and `thunderbolt logout` operate only on the stored session/device; when none exists they explain that an environment-managed PAT cannot be cleared by the CLI. A remaining PAT keeps Thunderbolt usable for direct models. Session logout remotely revokes first: network, 5xx, or ambiguous failure retains local state, while confirmed success removes it. There is no automatic reauthentication or prompt replay. Commands keep the existing simple success/nonzero behavior rather than introducing a new exit-code taxonomy. One-shot errors go to stderr; REPL errors leave the session usable; ACP prompt errors leave the server available.

## Architecture and external seam

The external provider seam has exactly three operations:

```ts
type ProviderRuntime = {
  snapshot: () => ProviderSnapshot
  manage: (command: ProviderCommand) => Promise<ProviderSnapshot>
  prepare: (selection: InvocationSelection, signal?: AbortSignal) => Promise<PreparedPiBinding>
}

type ProviderStatus = 'authenticated' | 'not authenticated' | 'authentication required'

type ProviderSnapshot = {
  revision: number
  activeProviderId: 'thunderbolt' | string | null
  thunderbolt: { status: ProviderStatus; defaultModelId: string }
  providers: Array<{ id: string; label: string; provider: string; status: ProviderStatus; defaultModel: string }>
}

type ProviderSwitchCommand =
  | { type: 'use'; providerId: 'thunderbolt' | string }
  | { type: 'commit-staged-byok'; providerId: string; activate: boolean }
  | { type: 'select-model'; providerId: 'thunderbolt' | string; model: string }

type ProviderCommand =
  | ProviderSwitchCommand
  | { type: 'remove-byok'; providerId: string }
  | { type: 'load-models'; providerId: 'thunderbolt' | string }
  | { type: 'login' | 'logout'; presentation: DeviceGrantPresentation; signal?: AbortSignal }
  | { type: 'clear-active' }
  | { type: 'commit-persistence'; command: ProviderSwitchCommand }
  | { type: 'rollback-persistence'; revision: number }
  | { type: 'finalize-persistence'; revision: number }

type InvocationSelection = {
  providerId?: 'thunderbolt' | string
  model?: string
  apiKey?: string
  baseUrl?: string
}

type PreparedPiBinding = {
  providerId: 'thunderbolt' | string
  modelId: string
  wireModel: string
  piModel: Model<Api>
  install: (models: MutableModels) => void
  dispose: () => Promise<void>
}
```

`commit-persistence`, `rollback-persistence`, and `finalize-persistence` implement the switching transaction.

Every prepared model is owned by exactly one provider/profile ID; `install` must register a Pi provider whose ID matches `piModel.provider`, and the runtime rejects a selection whose model does not belong to the chosen owner. `dispose` is idempotent and safe after partial preparation.

All failures cross the seam as a stable union:

```ts
type ProviderRuntimeError = {
  code:
    | 'config-invalid'
    | 'config-version-unsupported'
    | 'provider-not-found'
    | 'model-not-found'
    | 'authentication-required'
    | 'authentication-rejected'
    | 'device-disconnected'
    | 'WEB_LOGIN_REQUIRED'
    | 'quota-exceeded'
    | 'network'
    | 'attestation-failed'
    | 'transport-unsupported'
    | 'persistence-failed'
  message: string
}
```

Internally, Pi BYOK, OpenAI-compatible BYOK, Thunderbolt direct, and Thunderbolt Tinfoil adapters own construction, auth headers, and error normalization. New and repaired BYOK credentials live in a required internal `ProviderStageContext`: manager outcomes and `InvocationSelection` carry only the stable provider ID, and `commit-staged-byok` resolves the candidate internally. Stage cleanup is compare-and-swap guarded so disposal of an older prepared binding cannot erase a newer repair. No API key or secret-handoff abstraction is exposed through the external seam, command outcome, or bootstrapped run config.

## Persisted config, auth, and migration

Thunderbolt is structural; `providers` contains BYOK profiles only. A shared base is intersected with provider-discriminated variants. `provider` is the discriminator and no `kind` field exists.

```ts
type ByokBase = {
  id: string
  label: string
  defaultModel: string
  apiKey: string | null
  credentialStatus: 'authenticated' | 'not-authenticated' | 'authentication-required'
}

type ByokProfile = ByokBase &
  (
    | { provider: Exclude<BuiltinProvider, 'fireworks'> }
    | { provider: 'fireworks'; modelApi?: 'anthropic-messages' | 'openai-completions' }
    | { provider: 'openai-compat'; baseUrl: string }
  )

type CliConfig = {
  version: 3
  activeProviderId: 'thunderbolt' | string | null
  thunderbolt: { defaultModelId: string }
  providers: ByokProfile[]
}
```

`thunderbolt.defaultModelId` and each managed model `id` are stable catalog UUIDs. Managed `model` is the public wire/user-facing slug. BYOK `defaultModel` is the upstream model ID. No arbitrary environment-variable name is persisted; adapters recognize only their dedicated variables. A profile with `apiKey: null` may use its dedicated variable at runtime.

The secure account file represents the active installation even when its session bearer expires:

```ts
type CliAuthBase = {
  version: 2
  backendUrl: string
  deviceId: `cli-${string}`
  userCacheSecret: string
}

type CliAuth = CliAuthBase &
  (
    | { registration: 'legacy' | 'registered'; bearer: string }
    | { registration: 'authentication-required'; bearer: null }
  )

type ResolvedAccountCredential =
  | { type: 'session'; backendUrl: string; bearer: string; deviceId: `cli-${string}`; userCacheSecret: Uint8Array }
  | { type: 'pat'; backendUrl: string; token: string }
```

`deviceId` is `cli-` plus a canonical lowercase UUID. `userCacheSecret` is exactly 64 lowercase hexadecimal characters encoding 32 random bytes. It exists only for a web-session installation that can use Tinfoil.

The official build bakes production backend configuration. `THUNDERBOLT_CLOUD_URL` remains an advanced development/self-host override. `THUNDERBOLT_TOKEN` resolves the PAT variant, is environment-managed, never participates in onboarding, and is never persisted or device-bound. PAT precedence remains compatible with current `resolveBridgeCredential`: if present but rejected, it never falls back to the stored session.

Legacy unversioned config migrates atomically to version 3. Version 3, which has not shipped yet, also stores Fireworks-only `modelApi`; no version 4 is introduced. Known Fireworks IDs derive their exact protocol and base URL from Pi. An unknown migrated Fireworks ID without protocol remains active but becomes `authentication-required` until repair asks the user to choose Anthropic Messages or OpenAI Completions. Unknown models for uniform-protocol providers continue to synthesize from that single protocol. Legacy single-provider config otherwise migrates atomically to one active BYOK profile with `not-authenticated` status and without onboarding. Legacy auth registers on first managed use; `resolveBridgeCredential` reads bearer/backend from the new shape while ignoring device and Tinfoil metadata. Invalid JSON, invalid schemas, and future config versions are reported and never overwritten.

The state directory is mode `0700`; files are `0600`. Writes use a same-directory temporary file and atomic rename. Reads and writes reject symlink directories and targets. This scope does not add a general filesystem transaction, locking, or fsync subsystem.

## Account credential and device contract

Session credentials use `Authorization: Bearer`, are device-bound, and support register/touch/logout. PAT credentials use `x-api-key`, are permitted for existing bridges and managed direct inference, but skip CLI-device registration/logout and cannot be cleared by the CLI. Schema-v1 confidential Tinfoil is web-session-only: choosing GLM 5.2 while PAT is effective returns actionable `WEB_LOGIN_REQUIRED`. PAT never creates a cache secret, never reaches the Tinfoil proxy, and never submits a receipt.

`PUT /v1/account/devices/cli` uses `Authorization: Bearer` plus `X-Device-ID`, `X-Device-Name`, and `X-App-Version`; it has no request body. It validates `X-Device-ID` as `cli-<canonical UUID>`. In one transaction it verifies a non-anonymous user and real persisted Better Auth session, rejects PAT/synthetic sessions, requires `session.deviceId` to be null or equal to the requested ID, enforces the existing active-device cap for a new row, creates or touches a non-revoked CLI row, and binds the real session. New CLI rows set `deviceType: 'cli'`, `trusted: true`, `approvalPending: false`, and all public-key, encryption, node-ID, and attestation fields to null. The 200 JSON body contains exactly `deviceId` (the validated request ID) and `state: 'registered'`.

`POST /v1/account/devices/cli/logout` uses the session bearer and has no body or device ID. It derives the bound device, verifies CLI type, soft-revokes it, and deletes all linked sessions transactionally, returning 204. Existing remote revoke uses the same soft-revoke/session-delete path.

Confirmed logout success removes the entire auth/install file, including device ID and cache secret; a later login creates new values. A generic definitive 401/session-invalid response against the stored session credential instead sets `registration: 'authentication-required'` and clears only `bearer`, retaining the installation ID and cache secret; rejection of an effective PAT does not mutate this file. Explicit re-login obtains a new bearer and registers/touches the same ID, relinking the active session. If registration returns `DEVICE_DISCONNECTED` for a revoked tombstone, the CLI generates a new device ID and cache secret and retries registration exactly once. Tombstones never resurrect. Network/5xx/ambiguous logout failure retains all state.

The approval UI treats an anonymous session as requiring real sign-in. Backend registration repeats that rejection as defense in depth without changing anonymous web inference.

`deviceType` gains `'cli'` in backend/frontend types. The `cli-` ID namespace is server-reserved exactly like `bridge-`: PowerSync uploads reject its creation or overwrite, and normal device routes cannot create it. Normal registration, envelope approval/recovery, self-recovery, and `/devices/me/node-id` reject CLI rows. Server-managed device type, trust, user, and revocation remain blocked from uploads. CLI rows never enter the iroh allowlist. The device UI shows CLI label/name, last seen, state, and revoke action only; app version is not displayed unless the synced frontend schema is separately extended.

## Shared managed-model catalog

`GET /v1/config` gains an additive `managedModels` field:

```ts
type ManagedModels = {
  schemaVersion: 1
  version: number
  defaultModelId: string
  models: Array<{
    id: string
    model: string
    name: string
    description: string
    vendor: string
    transport: 'direct' | 'confidential'
    capabilities: {
      input: Array<'text' | 'image'>
      tools: boolean
      parallelToolCalls: boolean
      reasoning: boolean
      contextWindow: number
    }
    defaults: { startWithReasoning: boolean }
  }>
}
```

`version` is monotonic and equals `defaultModelsVersion`; array order is display order. `defaultModelId` and entry `id` are stable UUIDs, while `model` is the public request/flag slug. No upstream provider/model, credential, URL, price, or policy is serialized.

Every public direct entry has a private backend runtime mapping and canonical price. Every current confidential entry has an explicit Tinfoil policy and receipt identity; schema v1 requires GLM 5.2. Future direct entries on the current schema need no CLI release after runtime credentials/mapping, canonical pricing migration with `_journal.json` entry, and catalog deployment. The spec does not promise generic future confidential models until a server-verifiable accounting/routing protocol exists.

Publication is backend-first: pricing migration/journal, provider credentials, runtime mapping, and catalog readiness precede advertisement. The additive payload is safe for existing clients, which retain existing config fields.

## Pi direct and Tinfoil bindings

All CLI Pi packages exactly match the root pin, currently 0.80.7. The CLI does not assume Pi exposes fetch injection. Direct and confidential bindings either reuse/generalize the documented synchronous fetch binding in `shared/agent-core/openai-compat-model.ts` or use a CLI-owned custom Pi `ProviderStreams` adapter.

The direct adapter uses Pi `openai-completions`, the public managed slug, and an account wrapper that emits Bearer for session credentials or `x-api-key` for PAT credentials.

The confidential adapter accepts only the session credential. It uses an attested Tinfoil `SecureClient`; its account wrapper authenticates the proxy, while the validated 64-character cache secret reaches only `SecureClient` and the enclave inside the encrypted request. It is never sent as a Thunderbolt backend header or logged. Inference and receipt responses classify both 401 and 403 as stored-session authentication rejection; network failures, 429, and 5xx preserve the prior status and never replay. PAT selection fails before constructing this binding.

Receipt correlation is per stream/binding. The wrapper captures one `X-Inference-Usage-Receipt`; the corresponding finalized Pi assistant `message_end` consumes it. Prompt tokens equal `usage.input + usage.cacheRead + usage.cacheWrite`, completion tokens equal `usage.output`, and the provider's `usage.totalTokens` is preserved. A decrypted real Tinfoil fixture must prove these counts match existing client semantics. Pending receipt state clears after success, provider error, abort, and disposal so a stale header cannot bind to a later message.

Receipt POST uses the session bearer and existing bounded best-effort behavior. Failure never invalidates the answer or reruns inference. Confidential cleanup is idempotent, calls `SecureClient.reset()` when available, clears pending receipt state, and drops the reference.

## Switching transaction

Switching is idle-only:

1. Build and validate the new binding.
2. Snapshot the old persisted selection and atomically persist the new selection.
3. Install the new provider into the harness `MutableModels`.
4. Call awaited `AgentHarness.setModel` when the Pi model changes.
5. Commit the new active binding in memory.
6. If the provider ID changed, call `MutableModels.deleteProvider(oldProviderId)` so secret-bearing closures are not retained, then dispose the old binding.

If provider installation or `setModel` fails, the runtime reinstalls the old provider/model, atomically restores the old persisted selection, and disposes the new binding. A partial `setModel` failure may append a new-to-old model-change pair; that record is truthful because no turn runs between the two changes. Old-provider detachment and old-binding disposal are post-commit cleanup; their failure is reported and retried during disposal but does not revert the successful switch. A credential-only replacement under the same provider/model replaces provider streams without a redundant `setModel` call or model-change entry.

## Failure, retry, and no fallback

There is no provider, model, credential-source, direct/confidential, PAT-to-session, or anonymous fallback. Auth rejection, quota, revocation, invalid/future config, missing model, unsupported transport, and attestation failure stop immediately with actionable text.

No generic retry layer is added. Existing same-binding SDK behavior and Tinfoil key-mismatch recovery remain only where they prove the failed attempt was not processed. Reauthentication never replays a prompt. Errors retain a stable code and an actionable message.

## Credential storage and security

BYOK keys enter through hidden input, dedicated environment variables, secure config, or explicit override. OpenAI-compatible keys are endpoint-scoped. Successful add/repair validation persists `credentialStatus: 'authenticated'`; providers without a usable authenticated listing endpoint, and ambiguous timeout/network/5xx/invalid-body results, persist `not-authenticated`; a 401/403 persists `authentication-required`. A natural prompt updates this evidence only from its credentialed HTTP adapter: 2xx promotes, 401/403 demotes, and network/abort/429/5xx leave the previous status unchanged. Status bookkeeping cannot reject or replay a completed provider response; a persistence failure preserves the prior status and is reported separately. Synthetic harness `message_end` events never authenticate a credential. Environment/flag-only credentials and their status remain process-local. A PAT has a separate process-local status, starts `not authenticated`, and becomes authenticated only after its own direct 2xx; stored-session state and logout never confer that evidence. Logs, diagnostics, provider snapshots, and command displays redact credentials centrally.

Every credentialed request validates that its destination is the configured HTTPS Thunderbolt origin, with plain HTTP allowed only for loopback development hosts. Built-in model-list requests additionally pin each provider to its expected origin; custom OpenAI-compatible endpoints remain caller-owned after HTTPS/loopback validation. Redirects never carry replayable credentials. PATs never silently downgrade to sessions. Managed catalog data cannot redirect credentials to another origin. Confirmed logout/device replacement removes or rotates the bearer, device ID, and cache secret as defined above.

## ACP and bridge behavior

`thunderbolt acp serve` uses the same provider runtime and Pi adapters, honors saved selection and all per-process overrides, and never opens the wizard. Startup errors go to stderr/nonzero; prompt errors remain ACP errors and leave the server available. Direct and ACP never replay.

External ACP/MCP WSS, iroh, and connect commands stay outside the provider runtime. `resolveBridgeCredential` preserves PAT-first header behavior and session auto-trust behavior while ignoring CLI-device/cache metadata. CLI account devices and bridge devices retain separate IDs and revocation lifecycles.

## Compatibility and rollout

Updated web/desktop/mobile device schema and UI must ship before backend CLI registration is enabled or the CLI release is promoted; otherwise older clients can misrender CLI rows as normal E2EE devices. The existing minimum-version mechanism gates rollout where needed. This adds a device enum/type and UI behavior but no table, column, PowerSync client, or token family.

Backend routes, device guards, pricing/runtime mappings, and `managedModels` publish before the CLI depends on them. Legacy config/auth migrate lazily and atomically. `THUNDERBOLT_TOKEN`, provider environment variables, bridges, and `agent` remain compatible.

Release validation includes the compiled host CLI plus supported native release targets so Tinfoil crypto, dynamic/runtime assets, and certificates are present. CI path filters ensure shared managed-catalog changes trigger CLI tests, typecheck, and build.

## Testing and acceptance criteria

- First-run account/BYOK flows work in TUI/plain mode; non-TTY never prompts; `agent` behaves as the primary-command alias.
- `/providers` wording/state, persisted BYOK last-known auth status, account model UUID persistence, `/login`, `/logout`, and manager mutations match the contract.
- All four overrides are non-persisting; changed OpenAI-compatible URLs cannot receive saved keys; `--api-key` is redacted; duplicate provider/label shorthand produces an ambiguity error naming stable profile IDs.
- Reserved commands are intercepted and unknown slash text reaches Pi unchanged.
- PAT is absent from onboarding, succeeds for direct inference, rejects confidential selection with `WEB_LOGIN_REQUIRED`, skips device/receipt routes, cannot be cleared, and never falls back to session after rejection. Login/logout tests cover a stored web session while PAT remains effective.
- Legacy config/auth and `resolveBridgeCredential` support the new auth shape. Bridge tests cover PAT/session headers, PAT precedence, account auto-trust, revocation, and ignored device/cache metadata.
- State-file tests cover mode, atomic rename, interrupted migration, and symlink rejection without introducing general locking/fsync machinery.
- Device tests cover real-session binding, null-or-same device invariant, cap enforcement, PAT/synthetic/anonymous rejection, exact CLI row fields, idempotent touch, expired-session bearer replacement and same-ID relink, revoked-device one-time rotation, confirmed logout followed by a new-ID login, remote-first logout, and tombstone non-resurrection.
- Type-integrity tests prove the `cli-` upload namespace is rejected and CLI rows cannot enter normal/E2EE/recovery/node-ID/upload/iroh paths, while anonymous web inference remains unchanged.
- Catalog tests prove UUID/slug/default/order semantics, absence of private fields, exact current models, direct runtime/price one-to-one coverage, GLM confidential policy/receipt coverage, and future-direct compatibility. Pricing migration tests verify the Drizzle journal entry.
- Pi tests prove direct/ACP parity, same-Session switching, atomic persistence plus activation rollback, truthful new-to-old model-change pairs after partial failure, provider detachment, credential-only replacement without a model entry, idempotent cleanup, and exact version alignment.
- Tinfoil tests cover a decrypted usage fixture, header-then-error followed by a successful step, sequential tool steps, abort/disposal clearing, concurrent ACP harnesses, cache-token mapping, provider total preservation, and receipt-failure isolation.
- Security tests validate HTTPS on every credentialed request and permit only loopback HTTP development origins. Existing-client regressions cover additive config and safe CLI-device rollout. Native build tests cover Tinfoil assets. CI tests cover shared-catalog path filtering.
- No-fallback/no-replay tests assert no alternate adapter or second inference request is invoked.

## Delegated implementation and review rules

The root agent only coordinates agents and manages shared context. It does not edit, integrate, or implement fixes. All coding and corrections are delegated. Non-overlapping file ownership is parallelized; agents do not concurrently modify shared files.

Each coding agent runs checks configured today for its scope: CLI focused tests, CLI typecheck, CLI compiled build, and root/backend ESLint only where the configured commands cover changed files. It then performs an explicit simplification and cleanup pass, removing only unused code introduced by its change.

After each coding round, a different agent reviews the diff against this specification and repository rules and reruns the relevant configured checks. Every review fix is delegated. No round advances with unresolved findings. The final independent review covers direct/ACP parity, no fallback/replay, secure state, PAT/session precedence, device/type integrity, catalog/pricing parity, Tinfoil receipts, bridge regressions, native builds, and scoped CI.

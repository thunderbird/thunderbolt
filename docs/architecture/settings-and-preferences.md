# Settings and Preferences

User preferences live in one of two stores.

## Which store?

| Store                                                                                                           | Scope                            | Persistence                                     | Reset by                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Synced `settings` table ([`src/dal/settings.ts`](../../src/dal/settings.ts))                                    | Per account, every device        | SQLite → PowerSync → Postgres                   | `reset()` restores the shipped default row                                                                                             |
| Zustand `localSettingsStore` ([`src/stores/local-settings-store.ts`](../../src/stores/local-settings-store.ts)) | Per device (per browser profile) | `localStorage` key `thunderbolt-local-settings` | `clearLocalData`, when it wipes the database, writes `initialLocalSettings` back ([`src/lib/cleanup.ts:71`](../../src/lib/cleanup.ts)) |

**The rule:** credentials, machine-specific URLs and per-device choices stay local; anything
describing the _user_ (name, location, units, language, opt-ins, telemetry consent) is synced.

### The eight device-local fields

| Field                                  | Why it is device-local                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudUrl`                             | Which backend this install talks to                                                                                                                                                                            |
| `voiceProvider`                        | An API key plus a possibly-`localhost` base URL (see the comment at [`src/stores/local-settings-store.ts:9`](../../src/stores/local-settings-store.ts))                                                        |
| `isNativeFetchEnabled`, `debugPosthog` | Dev toggles                                                                                                                                                                                                    |
| `hapticsEnabled`                       | A phone has a motor and a desktop does not                                                                                                                                                                     |
| `externalLinkBehavior`                 | Its `sidebar` option needs the in-app side panel, so it degrades to the confirmation dialog wherever the panel is unavailable ([`src/lib/external-link-behavior.ts`](../../src/lib/external-link-behavior.ts)) |
| `theme`                                | Mirrored into a Tauri `theme.json` so the native shell can eventually read it before the WebView loads (`persistThemeToNativeStore`, [`src/lib/theme-provider.tsx`](../../src/lib/theme-provider.tsx))         |
| `syncEnabled`                          | Cannot be synced without a bootstrapping paradox: it is the switch that turns replication on ([`src/db/powersync/sync-state.ts:64`](../../src/db/powersync/sync-state.ts))                                     |

The store is plain persisted Zustand:

- `partialize` lists every field explicitly rather than spreading, so adding a field without
  persisting it is a type error and no store action leaks into `localStorage`.
- `getLocalSetting(key)` is the synchronous, per-key-typed read for non-React callers. The sync
  pipeline, HTTP client, proxy and eval runner read `cloudUrl` this way.

### The one field in neither store

**Use Cloud Proxy** lives in plain `localStorage` under `proxy_enabled`: written via
`useLocalStorage` ([`src/settings/preferences.tsx:207`](../../src/settings/preferences.tsx)), read
directly by [`src/lib/proxy-fetch.ts:36`](../../src/lib/proxy-fetch.ts). It only matters in Tauri; on
web `computeEffectiveProxyEnabled` is unconditionally `true` because CORS forces proxying. An
outlier, not a pattern to copy.

## The synced `settings` table

One row per key, every column `text`:

```ts
export const settingsTable = sqliteTable('settings', {
  // Column is named 'id' in DB for PowerSync compatibility, but accessed as 'key' in TypeScript
  key: text('id').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  defaultHash: text('default_hash'),
  userId: text('user_id'),
})
```

- **`id` vs `key`:** the SQL column is `id` because PowerSync requires that name; TypeScript sees
  `key`.
- **Composite PK on the backend:** `(id, user_id)`
  ([`backend/src/db/powersync-schema.ts:40`](../../backend/src/db/powersync-schema.ts)), so every
  account can hold the same key. See
  [composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md).
- **`updated_at` is not a last-writer signal.** Nothing reads it and no write path stamps it
  (`updateSettings` / `createSetting` set only `value` and `default_hash`; reset and reconcile spread
  a default row whose `updatedAt` is `null`). Convergence comes from the version markers below.
- **Values are strings in and out.** `serializeValue` stores strings unquoted, JSON-encodes the
  rest, and reads apply a type hint from your schema
  ([`src/lib/serialization.ts`](../../src/lib/serialization.ts)): `content_view_width: Number` yields
  `number | null` ([`src/layout/main-layout.tsx:34`](../../src/layout/main-layout.tsx)), `50` yields
  a non-nullable `number` defaulting to 50.

### Reading and writing

| Caller    | API                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Component | `useSettings(schema)`, reactive through PowerSync, so a write on another device updates the UI with no invalidation                          |
| Non-React | `getSettings(db, schema)` one-shot read, `updateSettings(db, record)` write ([`src/dal/settings.ts:136`, `:316`](../../src/dal/settings.ts)) |

Each key returns a hook object: `value`, `isModified`, `setValue`, `reset`,
`isLoading` / `isSaving`, raw row.

```tsx
const { preferredName, dataCollection } = useSettings({
  preferred_name: '',
  data_collection: false,
})
```

**Write a group of settings in one `updateSettings` call, never several `setValue`s in a
`Promise.all`.** Each write opens its own transaction and SQLite rejects a `begin` while one is open,
so a `Promise.all` over four loses all but the first; sequential awaits work but are non-atomic,
leaving (say) half a region's unit conventions applied
([`src/hooks/use-unit-defaults.ts:107-115`](../../src/hooks/use-unit-defaults.ts)).
[`src/hooks/use-language-setting.ts:33`](../../src/hooks/use-language-setting.ts) records the same
constraint for two dependent writes that cannot be batched.

Inserts use insert-then-catch-conflict rather than upsert: PowerSync exposes tables as views, and
views do not support `ON CONFLICT`.

### `settings.value` is encrypted, so the backend cannot read it

`settings: ['value']` is the first entry in `encryptedColumnsMap`
([`src/db/encryption/config.ts:31`](../../src/db/encryption/config.ts)), so with E2EE on the server
holds ciphertext for every value. E2EE is opt-in, but the design must hold for users who enable it:
**no server-side feature may depend on reading a setting row.** Hence the resolved UI language
travels as an `X-App-Language` header ([AGENTS.md](../../AGENTS.md#the-x-app-language-header),
[e2e-encryption.md](./e2e-encryption.md)).

## Defaults, modification tracking, and reset

[`src/defaults/settings.ts`](../../src/defaults/settings.ts) declares the shipped rows as
`defaultSettings`. Three mechanics hang off that array:

- **`defaultHash`** is a hash of `(key, value)`; a row whose current hash differs from the stored
  one is a user edit
  (`isSettingModified`, [`src/defaults/utils.ts`](../../src/defaults/utils.ts)), which drives the
  per-control revert affordance and tells reconcile to skip the row.
- **`reset()` only works for keys in `defaultSettings`.** Otherwise `useSettings` throws
  `No default setting found for key: …`
  ([`src/hooks/use-settings.ts:192`](../../src/hooks/use-settings.ts)).
- **A `null` shipped value is load-bearing, not an omission.** `preferred_name`, `location_*`, the
  four unit settings and `language` ship as `null` so reconcile's `wouldOverwriteUserValue` guard
  ([`src/lib/reconcile-defaults.ts:338`](../../src/lib/reconcile-defaults.ts)) preserves a seeded or
  user-set value across a version bump. Write them with `{ recomputeHash: true }` so they still look
  seeded and a later `reset()` means "back to auto".

**Changing that array requires bumping `defaultSettingsVersion`**
([`src/defaults/settings.ts:268`](../../src/defaults/settings.ts)); `src/defaults/settings.test.ts`
fails with instructions if you forget. The version is the ordering signal that lets devices converge
without ping-ponging: the rule in
[AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps), the algorithm in
[reconciled-defaults.md](./reconciled-defaults.md), the boot-time gate in
[app-initialization.md](./app-initialization.md).

### Keys the defaults array deliberately does not manage

Generated rather than shipped, so they are not reconciled: no default row, no `reset()`.

| Key                                | Written by                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anonymous_id`                     | Seeded once with `createSetting`, which leaves an existing row alone ([`src/lib/reconcile-defaults.ts:655`](../../src/lib/reconcile-defaults.ts)) |
| `selected_model`, `selected_agent` | The chat store, when you switch either ([`src/chats/chat-store.ts:272`, `:302`](../../src/chats/chat-store.ts))                                   |
| `onboarding_current_step`          | Onboarding                                                                                                                                        |
| `sidebar_state`                    | The sidebar                                                                                                                                       |
| `defaults_version.*`               | Reconcile, for itself                                                                                                                             |

Export copies the table wholesale ([export-format.md](./export-format.md)) and import upserts by
key, so an export carries the exporting device's version markers and anonymous id.

## Preview feature flags

Preview features are ordinary boolean settings named `experimental_feature_*`, so an opt-in reaches
every device on the account. Adding one:

1. **Declare the default row** in `src/defaults/settings.ts` (value `'false'`), bump
   `defaultSettingsVersion`, update the snapshot test.
2. **Add the toggle** to the _Preview Features_ block
   ([`src/settings/preferences.tsx:943`](../../src/settings/preferences.tsx)): a `Switch` beside a
   `ModificationIndicator` label wired to the setting's `isModified` and `reset`.
3. **Gate the feature** on `flag.value`, conditionally rendering routes rather than redirecting:
   `experimental_feature_voice` gates `/settings/voice` ([`src/app.tsx:271`](../../src/app.tsx)) and
   filters the settings nav
   ([`src/layout/sidebar/settings-sidebar.tsx:88`](../../src/layout/sidebar/settings-sidebar.tsx));
   `experimental_feature_tasks` gates `/tasks` plus its sidebar entry.

**Seed the flag's `useSettings` schema from init data, not a literal `false`.** `AppRoutes` reuses
what the init pipeline read from SQLite (`initData.experimentalFeatureTasks` /
`experimentalFeatureVoice`, [`src/app.tsx:220-222`](../../src/app.tsx), step 5 of
[`src/hooks/use-app-initialization.ts:360`](../../src/hooks/use-app-initialization.ts)). A literal
`false` leaves the gated route missing on the first render after launch, and the catch-all at
[`src/app.tsx:288`](../../src/app.tsx) `replace`s unmatched paths with `/not-found`, killing a deep
link before the query resolves.

`experimental_feature_tasks` also requires telemetry consent: enabling it with `data_collection` off
opens a modal, disabling telemetry disables the flag. The gate is skipped when no PostHog key is
configured (`telemetryAvailable`), which a self-hosted deployment could never satisfy.

## Map of the Preferences page

| Section (line)                 | Controls                                                                                | Store                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| User Experience (647)          | Theme, External Links, Haptic Feedback                                                  | Device-local                                                                              |
| Personalization (700)          | Preferred Name                                                                          | Synced (written on blur, not per keystroke)                                               |
| Localization (739)             | Location, Language, Distance, Temperature, Time Format, Currency                        | Synced                                                                                    |
| Help Thunderbolt Improve (943) | Preview Features (Tasks, Custom voice provider), Anonymous Usage Data                   | Synced                                                                                    |
| Network (1034)                 | Use Cloud Proxy                                                                         | `localStorage` `proxy_enabled`                                                            |
| Data (1072)                    | Sync This Device With Cloud, Export, Import, Delete All Local Data, Delete Your Account | `syncEnabled` device-local via `useSyncEnabledToggle`; the rest are actions, not settings |

[`src/settings/preferences.tsx`](../../src/settings/preferences.tsx) is 1349 lines: a `useReducer`
state machine (`preferencesReducer`) plus one long `PreferencesSettingsPage`. Two other pages edit
the device-local store: `/settings/voice`
([`src/settings/voice.tsx`](../../src/settings/voice.tsx), gated by the voice preview flag) for
`voiceProvider`; dev-only `/settings/dev-settings`
([`src/settings/dev-settings.tsx`](../../src/settings/dev-settings.tsx)) for `cloudUrl`,
`isNativeFetchEnabled`, `debugPosthog`.

Units, language and formatting rules (CLDR-derived defaults, `useFormatters()`, why `date_format`
was retired): [AGENTS.md](../../AGENTS.md#localization-i18n).

## Where the code lives

| File                                                                             | Role                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`src/db/tables.ts`](../../src/db/tables.ts)                                     | `settingsTable` (frontend SQLite)                                         |
| [`backend/src/db/powersync-schema.ts`](../../backend/src/db/powersync-schema.ts) | `settings` (Postgres, composite PK)                                       |
| [`src/dal/settings.ts`](../../src/dal/settings.ts)                               | `getSettings`, `updateSettings`, `createSetting`, `resetSettingToDefault` |
| [`src/hooks/use-settings.ts`](../../src/hooks/use-settings.ts)                   | The reactive per-key hook components use                                  |
| [`src/defaults/settings.ts`](../../src/defaults/settings.ts)                     | Shipped rows and `defaultSettingsVersion`                                 |
| [`src/defaults/settings.test.ts`](../../src/defaults/settings.test.ts)           | Snapshot pinning defaults to the version                                  |
| [`src/lib/reconcile-defaults.ts`](../../src/lib/reconcile-defaults.ts)           | Version markers, the overwrite gate, `wouldOverwriteUserValue`            |
| [`src/lib/serialization.ts`](../../src/lib/serialization.ts)                     | String storage format and type hints                                      |
| [`src/stores/local-settings-store.ts`](../../src/stores/local-settings-store.ts) | Device-local store, `initialLocalSettings`, `getLocalSetting`             |
| [`src/settings/preferences.tsx`](../../src/settings/preferences.tsx)             | The Preferences page                                                      |
| [`src/hooks/use-unit-defaults.ts`](../../src/hooks/use-unit-defaults.ts)         | Region-seeded unit settings, the group-write pattern                      |
| [`src/hooks/use-language-setting.ts`](../../src/hooks/use-language-setting.ts)   | The `language` setting and its publish-then-persist ordering              |

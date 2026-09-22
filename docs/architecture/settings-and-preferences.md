# Settings and Preferences

Thunderbolt keeps user preferences in two places, and picking the wrong one is the most common
mistake when adding a setting. This page is the decision rule, the mechanics of each store, and the
invariants that bite.

## Two stores, one decision

| Store                                                                                                           | Scope                            | Persistence                                     | Reset by                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Synced `settings` table ([`src/dal/settings.ts`](../../src/dal/settings.ts))                                    | Per account, every device        | SQLite → PowerSync → Postgres                   | `reset()` restores the shipped default row                                                                                             |
| Zustand `localSettingsStore` ([`src/stores/local-settings-store.ts`](../../src/stores/local-settings-store.ts)) | Per device (per browser profile) | `localStorage` key `thunderbolt-local-settings` | `clearLocalData`, when it wipes the database, writes `initialLocalSettings` back ([`src/lib/cleanup.ts:71`](../../src/lib/cleanup.ts)) |

**Anything that holds a credential, a machine-specific URL, or a genuinely per-device choice stays
local.** The store's eight fields are all one of those: `cloudUrl` (which backend this install talks
to), `voiceProvider` (an API key plus a possibly-`localhost` base URL — see the comment at
[`src/stores/local-settings-store.ts:9`](../../src/stores/local-settings-store.ts)),
`isNativeFetchEnabled` and `debugPosthog` (dev toggles), `hapticsEnabled` (a phone has a motor and a
desktop does not), `externalLinkBehavior` (its `sidebar` option needs the in-app side panel, so it
degrades to the confirmation dialog wherever the panel is unavailable —
[`src/lib/external-link-behavior.ts`](../../src/lib/external-link-behavior.ts)), `theme` (mirrored
into a Tauri `theme.json` so the native shell can eventually read it before the WebView loads, per
the comment on `persistThemeToNativeStore` in
[`src/lib/theme-provider.tsx`](../../src/lib/theme-provider.tsx)), and `syncEnabled` — which cannot
be synced without a bootstrapping paradox, since it is the switch that turns replication on
([`src/db/powersync/sync-state.ts:64`](../../src/db/powersync/sync-state.ts)).

Everything else that describes the _user_ rather than the _machine_ — their name, location, units,
language, feature opt-ins, telemetry consent — belongs in the synced table, so a second device
inherits it.

Two mechanics follow from the store being plain persisted Zustand:

- `partialize` lists every field explicitly rather than spreading and omitting, so adding a field
  without persisting it is a type error and no future store action can leak into `localStorage`.
- Non-React callers read it synchronously with `getLocalSetting(key)`, whose return type narrows per
  key. The sync pipeline, the HTTP client, the proxy and the eval runner all read `cloudUrl` this way.

One field escaped both stores: the **Use Cloud Proxy** toggle lives in plain `localStorage` under
`proxy_enabled`. The page edits it through `useLocalStorage`
([`src/settings/preferences.tsx:207`](../../src/settings/preferences.tsx)) and
[`src/lib/proxy-fetch.ts:36`](../../src/lib/proxy-fetch.ts) reads the same key straight out of
`localStorage` for callers that have no React context. The toggle only means anything in the Tauri
build — `computeEffectiveProxyEnabled` returns `true` unconditionally on web, where CORS forces
proxying. It is an outlier, not a pattern to copy.

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

The SQL column is `id` because PowerSync requires that name; TypeScript sees `key`. On the backend
the primary key is composite — `(id, user_id)` at
[`backend/src/db/powersync-schema.ts:40`](../../backend/src/db/powersync-schema.ts) — so every account
can hold a row with the same key. See
[composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md).

`updated_at` is not a last-writer signal, and nothing reads it. No settings write path stamps a
timestamp into it: `updateSettings` and `createSetting` set only `value` (plus `default_hash`), while
`resetSettingToDefault` and reconcile spread a shipped default row, whose `updatedAt` is `null`.
Convergence across devices comes from the defaults version markers described below, not from
timestamps.

Values are strings on the way in and out. `serializeValue` stores strings unquoted and JSON-encodes
everything else; reads pass a type hint derived from the schema you declare
([`src/lib/serialization.ts`](../../src/lib/serialization.ts)), which is why
`useSettings({ content_view_width: Number })` hands back a `number | null`
([`src/layout/main-layout.tsx:34`](../../src/layout/main-layout.tsx)) while a schema entry of `50`
would make the same row a non-nullable `number` defaulting to 50.

### Reading and writing

Components use `useSettings`, which takes a schema mapping keys to a type constructor or a default
value and returns one hook object per key — `value`, `isModified`, `setValue`, `reset`, plus
`isLoading` / `isSaving` and the raw row:

```tsx
const { preferredName, dataCollection } = useSettings({
  preferred_name: '',
  data_collection: false,
})
```

The query is reactive through PowerSync, so a write on another device updates the UI without
invalidation. Non-React code calls `getSettings(db, schema)` for a one-shot read and
`updateSettings(db, record)` to write ([`src/dal/settings.ts:136`, `:316`](../../src/dal/settings.ts)).

**Write a group of settings in one `updateSettings` call, never several `setValue`s in a
`Promise.all`.** Each write opens its own transaction and SQLite rejects a `begin` while one is open,
so a `Promise.all` over four of them loses all but the first. Sequential awaits work but leave the
group non-atomic — half a region's unit conventions, for instance. The rationale is written out at
the call site in [`src/hooks/use-unit-defaults.ts:107-115`](../../src/hooks/use-unit-defaults.ts), and
[`src/hooks/use-language-setting.ts:33`](../../src/hooks/use-language-setting.ts) records the same
constraint for two dependent writes that genuinely cannot be batched.

Inserts use insert-then-catch-conflict rather than upsert: PowerSync exposes tables as views, and
views do not support `ON CONFLICT`.

### `settings.value` is encrypted, so the backend cannot read it

`settings: ['value']` is the first entry in `encryptedColumnsMap`
([`src/db/encryption/config.ts:31`](../../src/db/encryption/config.ts)). On any deployment with E2EE
enabled the server stores ciphertext for every setting value. E2EE is opt-in and off by default, but
the design has to hold for the users who turn it on, which means **no server-side feature may depend
on reading a setting row**. That is why the client's resolved UI language travels as an
`X-App-Language` request header instead of a `language` column lookup — see
[the header contract in AGENTS.md](../../AGENTS.md#the-x-app-language-header) and
[e2e-encryption.md](./e2e-encryption.md).

## Defaults, modification tracking, and reset

[`src/defaults/settings.ts`](../../src/defaults/settings.ts) declares the shipped rows and exports
them as `defaultSettings`. Three mechanics hang off that array:

- **`defaultHash`** is a hash of `(key, value)`. A row whose current hash differs from its stored
  `defaultHash` is a user edit (`isSettingModified`,
  [`src/defaults/utils.ts`](../../src/defaults/utils.ts)) — that is what drives the revert affordance
  next to each control and what reconcile uses to leave edited rows alone.
- **`reset()` only works for keys present in `defaultSettings`.** `useSettings` throws
  `No default setting found for key: …` otherwise
  ([`src/hooks/use-settings.ts:192`](../../src/hooks/use-settings.ts)), so a key you write but never
  declare has no revert path.
- **A `null` shipped value is load-bearing, not an omission.** `preferred_name`, `location_*`, the
  four unit settings and `language` all ship as `null` so that reconcile's `wouldOverwriteUserValue`
  guard ([`src/lib/reconcile-defaults.ts:338`](../../src/lib/reconcile-defaults.ts)) recognises a
  seeded or user-set value and preserves it across a version bump. Writing such a setting from code
  passes `{ recomputeHash: true }`, which keeps it looking like a seeded default so a later `reset()`
  means "back to auto".

Changing anything in that array requires bumping `defaultSettingsVersion`
([`src/defaults/settings.ts:268`](../../src/defaults/settings.ts)); the colocated snapshot test
`src/defaults/settings.test.ts` fails with instructions if you forget. The version is the ordering
signal that lets multiple devices converge without ping-ponging — the rule in short in
[AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps), the algorithm in
[reconciled-defaults.md](./reconciled-defaults.md), and the boot-time gate in
[app-initialization.md](./app-initialization.md).

### Keys the defaults array deliberately does not manage

Some rows live in the same table but are not reconciled, because they are generated rather than
shipped: `anonymous_id` (seeded once with `createSetting`, which leaves an existing row alone —
[`src/lib/reconcile-defaults.ts:655`](../../src/lib/reconcile-defaults.ts)), `selected_model` and
`selected_agent` (written by the chat store when you switch either —
[`src/chats/chat-store.ts:272`, `:302`](../../src/chats/chat-store.ts)),
`onboarding_current_step`, `sidebar_state`, and the `defaults_version.*` markers reconcile writes for
itself. They have no default row, so they also have no `reset()`.

Note that data export copies the `settings` table wholesale
([export-format.md](./export-format.md)) and import upserts by key, so an export carries the
exporting device's version markers and anonymous id along with the user's real preferences.

## Preview feature flags

Preview features are ordinary boolean settings named `experimental_feature_*`, so an opt-in reaches
every device the account syncs to rather than staying on the machine that made it. Adding one end to
end:

1. **Declare the default row** in `src/defaults/settings.ts` (value `'false'`), add it to
   `defaultSettings`, bump `defaultSettingsVersion`, and update the snapshot test.
2. **Add the toggle** to the _Preview Features_ block of the Preferences page
   ([`src/settings/preferences.tsx:943`](../../src/settings/preferences.tsx)) — a `Switch` beside a
   `ModificationIndicator` label wired to the setting's `isModified` and `reset`, so the revert
   affordance works.
3. **Gate the feature** on `flag.value`. Routes are conditionally rendered rather than redirected:
   `experimental_feature_voice` gates `/settings/voice`
   ([`src/app.tsx:271`](../../src/app.tsx)) and also filters the settings nav
   ([`src/layout/sidebar/settings-sidebar.tsx:88`](../../src/layout/sidebar/settings-sidebar.tsx));
   `experimental_feature_tasks` gates `/tasks` plus its sidebar entry.

The one subtlety is boot ordering. `AppRoutes` seeds its `useSettings` schema with the values the
init pipeline already read from SQLite (`initData.experimentalFeatureTasks` /
`experimentalFeatureVoice`, [`src/app.tsx:220-222`](../../src/app.tsx), read at step 5 of
[`src/hooks/use-app-initialization.ts:360`](../../src/hooks/use-app-initialization.ts)) rather than
with a literal `false`. With a literal `false` the gated route would not exist for the first render
after every launch, and the catch-all at [`src/app.tsx:288`](../../src/app.tsx) redirects an
unmatched path to `/not-found` with `replace` — so a deep link into a gated route would be gone
before the setting query resolved.

`experimental_feature_tasks` additionally requires telemetry consent: turning it on with
`data_collection` off opens a modal, and turning telemetry off turns the flag off with it. The
consent gate is skipped when no PostHog key is configured (`telemetryAvailable`), since on a
self-hosted deployment it would otherwise be impossible to satisfy.

## Map of the Preferences page

[`src/settings/preferences.tsx`](../../src/settings/preferences.tsx) is 1349 lines: a `useReducer`
state machine (`preferencesReducer`) and one long `PreferencesSettingsPage`. Its sections, and which
store each control writes to:

| Section (line)                 | Controls                                                                                | Store                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| User Experience (647)          | Theme, External Links, Haptic Feedback                                                  | Device-local                                                                              |
| Personalization (700)          | Preferred Name                                                                          | Synced (written on blur, not per keystroke)                                               |
| Localization (739)             | Location, Language, Distance, Temperature, Time Format, Currency                        | Synced                                                                                    |
| Help Thunderbolt Improve (943) | Preview Features (Tasks, Custom voice provider), Anonymous Usage Data                   | Synced                                                                                    |
| Network (1034)                 | Use Cloud Proxy                                                                         | `localStorage` `proxy_enabled`                                                            |
| Data (1072)                    | Sync This Device With Cloud, Export, Import, Delete All Local Data, Delete Your Account | `syncEnabled` device-local via `useSyncEnabledToggle`; the rest are actions, not settings |

Two related pages read the device-local store directly: `/settings/voice`
([`src/settings/voice.tsx`](../../src/settings/voice.tsx), gated by the voice preview flag) edits
`voiceProvider`, and the dev-only `/settings/dev-settings`
([`src/settings/dev-settings.tsx`](../../src/settings/dev-settings.tsx)) edits `cloudUrl`,
`isNativeFetchEnabled` and `debugPosthog`.

The units, language and formatting settings have their own rules — CLDR-derived defaults, the
`useFormatters()` requirement, why `date_format` was retired — documented in
[AGENTS.md](../../AGENTS.md#localization-i18n).

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
| [`src/hooks/use-unit-defaults.ts`](../../src/hooks/use-unit-defaults.ts)         | Region-seeded unit settings — the group-write pattern                     |
| [`src/hooks/use-language-setting.ts`](../../src/hooks/use-language-setting.ts)   | The `language` setting and its publish-then-persist ordering              |

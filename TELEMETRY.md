# Telemetry

## Privacy Policy - [[PAGE]](https://www.thunderbird.net/en-US/privacy/)

Event tracking respects user privacy settings and can be disabled through the application settings. No personally identifiable information is collected without explicit user consent.

## Event Tracking

Thunderbolt uses PostHog for analytics to track user interactions and application usage. All events follow a structured naming convention for better organization and analysis.

Event properties must never include prompts, responses, API keys, or other user-authored content. Use non-secret scalar identifiers such as `model_id`, `model_name`, and `provider`; a final egress scrub removes any property named `apiKey` before sending.

### Event Naming Convention

Events follow the pattern: `<feature>_<action>`

- **Feature**: The main area of the application (e.g., `chat`, `task`, `automation`)
- **Action**: The specific action being performed (e.g., `send_prompt`, `add`, `create`)

### Super and Person Properties

`locale` — the resolved app locale — is registered as a PostHog super property and set as a person property whenever the active language settles (`src/hooks/use-app-language.ts`). It rides on every captured event, including the ones documented below, and it is the only super property the app registers.

### Event Categories

#### Chat & Messaging (`chat_*`)

- `chat_send_prompt` - User sends a message to the AI (with `trace_id`, `model_id`, `model_name`, `provider`, `length`, and `prompt_number`)
- `chat_send_prompt_overflow` - User attempts a prompt that exceeds the model context (with the same scalar model properties, `length`, and `prompt_number`)
- `chat_receive_reply` - AI generates a response (with `trace_id`, `engine`, `model_id`, `model_name`, `provider`, `length`, and `reply_number`)
- `chat_auto_retry` - A built-in turn schedules an automatic retry (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, `attempt`, `max_retries`, and `reason`)
- `chat_retry_success` - An automatically retried built-in turn succeeds (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, and `attempts`)
- `chat_retries_exhausted` - A built-in turn stops retrying (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, `attempts`, and `reason`)
- Retry `reason` uses the stable error class produced by `classifyErrorKind` (`src/lib/error-utils.ts`), which reads only the error name, HTTP status, and message — never the response body as text. A status embedded in pi-ai's message string is recovered first, then, in precedence order: a Tinfoil attestation failure is `attestation` (or `timeout` when the attestation itself timed out); 429 is `rate-limit`; 408 or a Tinfoil upstream-timeout marker is `timeout`; a known provider error name (`KeyConfigMismatchError`, `ProtocolError`, `DecryptionError`), a 400/422 content rejection, or a 5xx is `provider`; a `TypeError` whose message matches a fetch-failure marker is `network`. Anything unrecognized is reported as `unknown`. `ChatErrorKind` has no content-rejection bucket, so 400/422 rejections are deliberately folded into `provider` — they are not separable on the dashboard. A retry with no error to classify reports the condition instead: `empty-response`, `web_budget_exhausted` or `request_budget_exhausted`.
- `chat_turn_completed` - One privacy-safe summary per built-in turn, including `trace_id`, actual `engine`, scalar model/provider identifiers, outcome/error class, attempts/retry layers/retry reasons, phase timings, user-perceived TTFT, step/tool counts, capped tool timings, and total duration. Recovered malformed tool calls add `tool_call_validation_failure_count` and the unique, canonically ordered `tool_call_validation_failure_kinds` enum (`no_such_tool`, `invalid_tool_input`, or `other`); both properties are omitted when the count is zero. TTFT is measured when the first non-empty text or reasoning delta reaches the adapter response stream, after translator/smoothing overhead. MCP calls use the fixed tool label `mcp`; user-authored server-name-derived identifiers are never emitted.
- `chat_turn_error` - A built-in turn ends in an error (with `kind` — the same stable error class as above, `unknown` when unclassified — plus `error_name`, `status`, `retryable`, and the turn's `trace_id`, `engine` and scalar model/provider identifiers)
- `tinfoil_attestation` - A Tinfoil client attestation succeeds, fails, or times out (with `outcome`, `duration_ms`, `client`, optional `error_name`, and, for turn acquisitions, `trace_id`, `engine`, `model_id`, and `provider`)
- `chat_select` - User selects a chat thread
- `chat_new_clicked` - User creates a new chat
- `chat_delete` - User deletes a chat
- `chat_clear_all` - User clears all chats

#### Model Management (`model_*`)

- `model_select` - User selects a different AI model

#### Agents & ACP (`agent_select`, `acp_*`)

- `agent_select` - User selects an agent for a chat (with `agent`, the agent row id)
- `acp_mode_changed` - A connected ACP agent reports a session mode change (with `mode_id`)
- `acp_config_options_changed` - A connected ACP agent reports a new set of config options (with `count` only — option names are the agent's, not ours)

`mode_select` is declared in the `EventType` union but has no call site.

#### Settings (`settings_*`)

- `settings_theme_set` - User changes the application theme
- `settings_name_set` - User sets their preferred name initially
- `settings_name_update` - User updates their preferred name
- `settings_name_clear` - User clears their preferred name
- `settings_location_set` - User sets their location initially
- `settings_location_update` - User updates their location
- `settings_localization_update` - User updates a localization setting (language, distance unit, temperature unit, time format, currency)
- `settings_localization_reset` - User resets one localization setting back to its auto-derived default
- `settings_external_link_behavior_update` - User changes how external links open (with `behavior`)
- `settings_database_reset` - User resets the application database
- `settings_data_export` - User exports their data to a JSON file
- `settings_data_import` - User imports a previously exported file
- `settings_data_collection_enabled` - User enables data collection
- `settings_data_collection_disabled` - User disables data collection
- `settings_experimental_feature_tasks_enabled` / `settings_experimental_feature_tasks_disabled` - User toggles the experimental tasks feature. Turning data collection off also turns the feature off, so it emits the `_disabled` event too.
- `settings_sync_enabled` / `settings_sync_disabled` - User turns multi-device sync on or off. `settings_sync_enabled` also fires when the sync setup wizard completes.

#### Task Management (`task_*`)

- `task_add` - User adds a new task
- `task_mark_complete` - User marks a task as complete
- `task_update_text` - User edits task text
- `task_reorder` - User reorders tasks
- `task_search` - User searches through tasks

#### Automation (`automation_*`)

- `automation_modal_create_open` - Create automation modal opens
- `automation_create` - New automation is created
- `automation_modal_edit_open` - Edit automation modal opens
- `automation_update` - Existing automation is updated
- `automation_run` - Automation is executed
- `automation_delete_clicked` - Delete automation button is clicked
- `automation_delete_confirmed` - Automation deletion is confirmed

#### Content View & Preview (`content_view_*`, `preview_*`)

- `content_view_open` - Content view opens (with properties: `view_type`, `tool_name` for object views, `sideview_type` for sideviews). MCP object views use the fixed `tool_name` value `mcp`.
- `content_view_close` - Content view closes (with property: `view_type`)
- `preview_open` - Preview webview opens from a link click
- `preview_close` - Preview webview closes
- `preview_copy_url` - User copies URL from preview header
- `preview_open_external` - User opens preview URL in external browser

#### UI & Navigation (`ui_*`)

- `ui_shortcut_use` - User uses a keyboard shortcut
- `ui_sidebar_open` - Sidebar opens
- `ui_sidebar_close` - Sidebar closes

#### Skills (`skill_*`)

Every `skill_*` event carries `skill_id` — `sha256(user_id + ':' + skill.id)` truncated to 16 hex characters (`src/skills/telemetry.ts`). Skill UUIDs are already opaque; salting with the user id additionally makes the same skill uncorrelatable across users, which matters once skills become shareable. No skill name or instruction text is ever sent.

- `skill_used` - A skill is applied to a prompt (with `via`: `slash`, `chip` or `settings-nav`)
- `skill_created` - A skill is created (with `instruction_length`)
- `skill_edited` - A skill is edited (with `renamed`)
- `skill_deleted` - A skill is deleted
- `skill_pinned` / `skill_unpinned` - A skill is pinned to or unpinned from the composer bar
- `skill_reordered` - Pinned skills are reordered (with `from_index`, `to_index`)

#### Search (`search_*`)

The typed query is never sent — only which kind of thing the user opened.

- `search_palette_open` - The command palette opens (closed→open transitions only)
- `search_result_select` - User opens a result (with `entityType` — one of `chat`, `message`, `model`, `skill`, `agent`, `mcp`, `device`, `task`, `project` — and `jumpToMessage`)
- `search_command_run` - User runs a palette command (with `commandId`)

#### Account

- `anonymous_user_promoted` - An anonymous session became a real account. Fired immediately after `posthog.alias(newUserId, anonId)` links the two distinct ids, so the pre-signup history stays attached to the account. The SSO redirect path unloads the page mid-flow, so it resumes from `sessionStorage` on return (`src/lib/analytics/anonymous-promotion-sso-bridge.ts`).

#### Data Migrations

- `automations_migration_run` - The legacy automations→skills migration ran (with `count` migrated and `stranded`). It fires on every run, including when both counts are zero: the all-zero events are the signal that the population has converged and THU-560 can delete the legacy subsystem, and `stranded` rows are automations still alive in `promptsTable` that a count-only signal would miss.

#### Startup Performance (`app_*`)

Diagnostic events for investigating app initialization time. All timing values are whole milliseconds measured from navigation start (`performance.timeOrigin`).

- `app_init_timing` - Fired once per initialization run, after the init pipeline completes. Properties:
  - `bundle_evaluated_ms` - entry bundle downloaded, parsed and evaluated
  - `app_mounted_ms` - first render of the root React component
  - `step0_fetch_config_ms` … `step8_initialize_posthog_ms` - duration of each init step. `src/lib/init-timing.ts` emits one `<label>_ms` property per recorded step, so the set follows the `time('…')` call sites in `src/hooks/use-app-initialization.ts` rather than a fixed list — a new step appears on the event automatically, and this list needs updating when one is added. Besides the numbered steps it currently carries `step0_5_storage_check_ms`, `step2b_db_ready_ms` (the first trivial query, which pays PowerSync's deferred ready gate), `step2c_returning_boot_probe_ms`, `step2d_build_search_index_ms` (the unified full-text index, rebuilt only when missing or after a schema-version bump) and `step4b_run_data_migrations_ms`. `step6_create_http_client_ms` is recorded only when the app builds its own HTTP client rather than receiving an injected one.
  - `init_total_ms` - total pipeline duration
  - `init_run` - run counter (greater than 1 means the user retried after an init error)
  - `initial_sync_outcome` - how the initial-sync gate resolved: `disabled`, `synced`, `timed_out`, `failed`, or `skipped_returning` when the returning-boot fast path started the sync in the background instead of waiting. Expect `skipped_returning` to dominate on established devices.
  - `init_path` - `returning` when that fast path applied, `fresh` otherwise
  - `sync_enabled`, `platform` - segmentation context
- `app_chat_ready` - Fired at most once per session when the first chat finishes hydrating (with `chat_ready_ms`). Together with `app_init_timing`, this captures the user-perceived time to a usable chat.

#### Sync Diagnostics (`sync_*`)

Diagnostic events for debugging sync issues (especially iOS). All events include shared context: `platform`, `ps_config`, `ps_connected`, `ps_connecting`, `ps_has_synced`, `ps_last_synced_at`, `ps_uploading`, `ps_downloading`, `uptime_ms`.

- `sync_connect` - PowerSync connected successfully
- `sync_connect_error` - PowerSync connection failed (with `error`)
- `sync_disconnect` - PowerSync disconnected (with `trigger`: `'user'` or `'reconnect'`)
- `sync_reconnect_start` - Reconnect attempt started (with `trigger`: `'visibility'` or `'manual'`)
- `sync_reconnect_success` - Reconnect succeeded (with optional `hidden_duration_ms`)
- `sync_reconnect_error` - Reconnect failed (with `error`, `trigger`)
- `sync_visibility_change` - App visibility changed (with `state`, `hidden_duration_ms`, `will_reconnect`, `ms_since_last_download`)
- `sync_credentials_fetch` - Token refresh succeeded (with `expires_in_ms`)
- `sync_credentials_error` - Token refresh failed (with `status`, `error_code`, `had_token`)
- `sync_upload` - CRUD upload succeeded (with `operation_count`)
- `sync_upload_error` - CRUD upload failed (with `error`, `operation_count`)
- `sync_status_change` - PowerSync connected↔disconnected transition (with `prev_connected`, `ms_since_last_change`)

### Server-Side Events

The backend captures two events of its own through `posthog-node`. Both are no-ops when `POSTHOG_API_KEY` is unset — the same key the backend hands the browser from `/posthog/config`, so leaving it unset is how a self-hosted deployment turns analytics off on both halves at once (see `docs/self-hosting/configuration.md`).

- `$ai_generation` - captured per managed inference request (`backend/src/inference/routes.ts`), attributed to the calling `user.id`. The `/chat/completions` route lets `@posthog/ai`'s wrapped OpenAI client emit it, passing `model_provider`, `model` (the internal model name), `endpoint`, `has_tools` and `temperature`; the Anthropic Messages route captures it directly with `model_provider`, `model`, `endpoint`, `has_tools`, `$ai_trace_id`, `$ai_provider`, `$ai_model`, `$ai_latency`, `$ai_http_status`, `$ai_is_error`, plus `$ai_input_tokens`/`$ai_output_tokens` when the upstream reported usage.
- `inference_upstream_error` - an inference request failed upstream. Both proxies emit it: the managed routes (`backend/src/inference/routes.ts`) on a handler throw or a mid-stream error, and the confidential Tinfoil proxy (`backend/src/tinfoil/routes.ts`) on a non-2xx enclave response, an idle-timed-out stream, or a connection failure. Every payload carries `provider`, `status` and `errorKind` — a fixed enum from `backend/src/inference/error-kind.ts`, derived from the provider error code/type and the HTTP status; the enum ships, the provider's message never does. The managed routes add `model`, `errorType`, `errorCode` and `requestId` where the SDK exposed them, plus `phase: 'stream'` for a failure after headers. The Tinfoil proxy can only add `subpath` (and `phase`): the enclave body is HPKE-opaque, so status and subpath are all it can read.

The node client runs with `privacyMode: true`. That is not sufficient on its own: `@posthog/ai` bypasses privacy mode for the raw provider `$ai_error` string, so `getPostHogClient` wraps `capture` and pushes it through `redactAiError` (`backend/src/posthog/client.ts`), keeping only `name`, `status`, `statusCode`, `httpStatus`, `code`, `type`, `param` and `requestID` and dropping the property entirely when none of those are present. Prompts and responses never reach PostHog; `backend/src/inference/posthog-privacy.test.ts` pins that end to end.

### Privacy Controls

`initPosthog` (`src/lib/posthog.tsx`) reads the public project key from the backend's `/posthog/config`. A deployment that configured no key gets no client at all, and `trackEvent` becomes a no-op — which is why `useTelemetryAvailable` derives from the client rather than from the user's consent setting. `api_host` points at `${cloudUrl}/posthog`, a proxy on our own backend (`backend/src/posthog/routes.ts`), so the browser never contacts PostHog directly.

The client is initialized with `opt_out_capturing_by_default` set from the stored `data_collection` setting, and the Settings toggle calls `opt_in_capturing`/`opt_out_capturing`. Autocapture, pageviews, pageleaves, exception capture, session recording, surveys, scroll properties, performance capture and external dependency loading are all disabled, so nothing is collected that an explicit `trackEvent` call did not ask for.

A `before_send` hook runs on every event as the last gate: `sanitizeUrl` reduces `$current_url`, `url`, `$pathname` and `$referrer` to their route pattern (`/chats/:chatThreadId`) and drops query strings and hashes, and `stripApiKeys` deletes any property named `apiKey` anywhere in the property tree, at any depth.

`trackError` reports a `HandleError` as a PostHog exception carrying its code, message and stack trace. PostHog's own initialization failure (`POSTHOG_FETCH_FAILED`) is skipped, so a broken analytics pipeline cannot report itself in a loop.

### Implementation

Events are tracked using the `trackEvent` function from `src/lib/posthog.tsx`:

```typescript
import { trackEvent } from '@/lib/posthog'

// Track a simple event
trackEvent('chat_send_prompt')

// Track an event with properties
trackEvent('chat_send_prompt', {
  model_id: 'model-row-id',
  model_name: 'gpt-4',
  provider: 'openai',
  length: 150,
})
```

### Type Safety

All event names are typed using the `EventType` union type, ensuring:

- Only valid event names can be used
- Autocomplete support in IDEs
- Compile-time error checking for typos

### Adding New Events

To add a new event:

1. Add the event name to the `EventType` union in `src/lib/posthog.tsx`
2. Use the `<feature>_<action>` naming convention
3. Add the tracking call in the appropriate component
4. Include relevant properties for analytics insights
5. Update this file to document it

The union is the source of truth and the catalogue above is meant to match it one for one — this file is what the product links to as its data-collection disclosure, so an event that ships without an entry here is collection nobody documented.

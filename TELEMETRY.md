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

### Event Categories

#### Chat & Messaging (`chat_*`)

- `chat_send_prompt` - User sends a message to the AI (with `trace_id`, `model_id`, `model_name`, `provider`, `length`, and `prompt_number`)
- `chat_send_prompt_overflow` - User attempts a prompt that exceeds the model context (with the same scalar model properties, `length`, and `prompt_number`)
- `chat_receive_reply` - AI generates a response (with `trace_id`, `engine`, `model_id`, `model_name`, `provider`, `length`, and `reply_number`)
- `chat_auto_retry` - A built-in turn schedules an automatic retry (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, `attempt`, `max_retries`, and `reason`)
- `chat_retry_success` - An automatically retried built-in turn succeeds (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, and `attempts`)
- `chat_retries_exhausted` - A built-in turn stops retrying (with `trace_id`, `engine`, turn-stable `model_id`/`model_name`/`provider`, `attempts`, and `reason`)
- Retry `reason` uses the stable error class. Pi-engine errors classify 408, 429, and 5xx statuses embedded by pi-ai as `timeout`, `rate-limit`, and `provider`; other or unrecognized errors remain `unknown`.
- `chat_turn_completed` - One privacy-safe summary per built-in turn, including `trace_id`, actual `engine`, scalar model/provider identifiers, outcome/error class, attempts/retry layers/retry reasons, phase timings, user-perceived TTFT, step/tool counts, capped tool timings, and total duration. Recovered malformed tool calls add `tool_call_validation_failure_count` and the unique, canonically ordered `tool_call_validation_failure_kinds` enum (`no_such_tool`, `invalid_tool_input`, or `other`); both properties are omitted when the count is zero. TTFT is measured when the first non-empty text or reasoning delta reaches the adapter response stream, after translator/smoothing overhead. MCP calls use the fixed tool label `mcp`; user-authored server-name-derived identifiers are never emitted.
- `tinfoil_attestation` - A Tinfoil client attestation succeeds, fails, or times out (with `outcome`, `duration_ms`, `client`, optional `error_name`, and, for turn acquisitions, `trace_id`, `engine`, `model_id`, and `provider`)
- `chat_select` - User selects a chat thread
- `chat_new_clicked` - User creates a new chat
- `chat_delete` - User deletes a chat
- `chat_clear_all` - User clears all chats

#### Model Management (`model_*`)

- `model_select` - User selects a different AI model

#### Settings (`settings_*`)

- `settings_theme_set` - User changes the application theme
- `settings_name_set` - User sets their preferred name initially
- `settings_name_update` - User updates their preferred name
- `settings_name_clear` - User clears their preferred name
- `settings_location_set` - User sets their location initially
- `settings_location_update` - User updates their location
- `settings_localization_update` - User updates localization settings (temperature, wind speed, precipitation, time format, language)
- `settings_database_reset` - User resets the application database
- `settings_data_collection_enabled` - User enables data collection
- `settings_data_collection_disabled` - User disables data collection

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

#### Startup Performance (`app_*`)

Diagnostic events for investigating app initialization time. All timing values are whole milliseconds measured from navigation start (`performance.timeOrigin`).

- `app_init_timing` - Fired once per initialization run, after the init pipeline completes. Properties:
  - `bundle_evaluated_ms` - entry bundle downloaded, parsed and evaluated
  - `app_mounted_ms` - first render of the root React component
  - `step0_fetch_config_ms` … `step8_initialize_posthog_ms` - duration of each init step (including `step2b_db_ready_ms` — the first trivial query that pays PowerSync's deferred ready gate — plus `step4b_run_data_migrations_ms` and `step6_create_http_client_ms`)
  - `init_total_ms` - total pipeline duration
  - `init_run` - run counter (greater than 1 means the user retried after an init error)
  - `initial_sync_outcome` - how the initial-sync gate resolved: `disabled`, `synced`, `timed_out` or `failed`
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

### LLM generation spans (backend)

When `POSTHOG_API_KEY` is set, the backend emits one OpenTelemetry span per managed LLM call on `POST /v1/chat/completions` and `POST /v1/chat/v1/messages`. It exports them to PostHog's OTLP endpoint (`${POSTHOG_HOST}/i/v0/ai/otel`), where each span becomes an `$ai_generation` event. Attribute names follow the OpenTelemetry GenAI conventions and live in `shared/telemetry/gen-ai.ts`.

The span is named `chat {model}` (for example `chat claude-opus-5`) and has kind `CLIENT`. It starts before the upstream request and ends when the stream finishes, fails, or the client cancels.

| Attribute                                  | Meaning                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `gen_ai.operation.name`                    | Always `chat`                                                                                                |
| `gen_ai.provider.name`                     | The provider serving the call: `anthropic` (the spec value), otherwise our internal name such as `fireworks` |
| `gen_ai.request.model`                     | Upstream model we asked for                                                                                  |
| `gen_ai.response.model`                    | Model the upstream says it used, when reported                                                               |
| `gen_ai.request.stream`                    | Always `true`                                                                                                |
| `gen_ai.response.finish_reasons`           | Why the model stopped (`stop`, `end_turn`, ...), when reported                                               |
| `gen_ai.response.time_to_first_chunk`      | Seconds from span start to the first upstream chunk                                                          |
| `gen_ai.usage.input_tokens`                | All input tokens, cached ones included                                                                       |
| `gen_ai.usage.output_tokens`               | Output tokens                                                                                                |
| `gen_ai.usage.cache_read.input_tokens`     | Input tokens read from the prompt cache                                                                      |
| `gen_ai.usage.cache_write.input_tokens`    | Input tokens written to the prompt cache (current spec name)                                                 |
| `gen_ai.usage.cache_creation.input_tokens` | Same value as above, under the older name PostHog uses for pricing                                           |
| `gen_ai.usage.reasoning.output_tokens`     | Reasoning tokens, when the OpenAI-shaped upstream reports them                                               |
| `error.type`                               | Error class on failure (for example `rate_limit`, `bad_request`); the span status is `ERROR`                 |
| `server.address`                           | Hostname of the upstream API the call actually went to (for example `api.anthropic.com`)                     |
| `posthog.distinct_id`                      | The user ID, so the generation joins the user's other PostHog events                                         |
| `$ai_cache_reporting_exclusive`            | Always `false`, because input tokens include cached tokens                                                   |
| `$ai_total_cost_usd`                       | The cost recorded in our usage ledger, in US dollars                                                         |
| `thunderbolt.endpoint`                     | The route path that served the call                                                                          |

**Trace parent.** If the request has a valid W3C `traceparent` header, the span becomes a child of that trace. An invalid header is ignored and the span starts a new trace. The span is never a child of the backend's HTTP request span, because PostHog drops non-GenAI spans and the generation would point at a missing parent.

**Allowlist.** Before export, the backend drops every span without `gen_ai.operation.name` and strips every attribute not in the table above. The OpenTelemetry resource is replaced by `service.name` alone, so host, process, and command-line details never leave the server. PostHog has no privacy mode on this path and stores whatever it receives, so the allowlist is the privacy boundary.

**Never emitted:** prompts, responses, system instructions, tool definitions, tool call arguments or results, API keys, and raw provider error messages.

Setting `OTEL_EXPORTER_OTLP_ENDPOINT` sends the same spans, plus HTTP request spans, to a generic OTLP collector. That export is unfiltered.

### Turn and tool spans (client)

Once PostHog is initialized, the app also emits OpenTelemetry spans for each built-in turn. It exports them to `${cloudUrl}/posthog/i/v0/ai/otel`. The backend proxy adds `Authorization: Bearer <POSTHOG_API_KEY>` on that path only. The spans use the same allowlist as the backend (`shared/telemetry/gen-ai.ts`), and the resource is only `service.name=thunderbolt-app`.

- **`invoke_agent thunderbolt`** (INTERNAL, the trace root): starts when the turn starts and ends when `chat_turn_completed` is sent (success, error, retries exhausted, or abort). Attributes: `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=thunderbolt`, `gen_ai.request.model` (model slug), `gen_ai.provider.name`, `thunderbolt.engine`, `thunderbolt.outcome` (`success`, `error`, or `abort`), and `posthog.distinct_id` (the posthog-js anonymous id). A failed turn adds `error.type` (the payload's `error_class`) and has status `ERROR`.
- **`execute_tool {name}`** (INTERNAL, child of the turn span): one per tool call that has a recorded duration, at the same point that fills `tools` in `chat_turn_completed`. Attributes: `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.type=function`, `posthog.distinct_id`, and `error.type=tool_error` on failure. MCP tools use the fixed name `mcp`. The span ends when the turn completes and is back-dated by the tool's duration, so its length is right but its position in the turn is approximate.

**Trace id.** The span's trace id is a uuidv7 without dashes (32 hex characters). `trace_id` in the chat events uses this same value, so events and spans join on it. Without a tracer provider (no PostHog key) `trace_id` stays a dashed uuidv7.

**Trace propagation.** The app sends a W3C `traceparent` header for the turn span only on the managed `/v1/chat/completions` and `/v1/chat/v1/messages` calls, so the backend's `chat` spans become children of the turn. BYOK, universal-proxy, and Tinfoil calls never get it, and `traceparent`/`tracestate` are never forwarded through `/v1/proxy`.

**Consent.** The span processor drops every span while posthog-js is opted out, so the Data collection toggle in Settings controls spans exactly like events.

**Never emitted:** prompts, responses, tool arguments or results, MCP server or tool names, and error messages.

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

1. Add the event name to the `EventType` union in `src/lib/analytics.tsx`
2. Use the `<feature>_<action>` naming convention
3. Add the tracking call in the appropriate component
4. Include relevant properties for analytics insights
5. Update this file to document it

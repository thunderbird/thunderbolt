# Telemetry

## Privacy Policy - [[PAGE]](https://www.thunderbird.net/en-US/privacy/)

Event tracking respects user privacy settings and can be disabled through the application settings. No personally identifiable information is collected without explicit user consent.

Data collection is enabled by default in dev builds and will be disabled by default in release/prod builds.

## Event Tracking

Thunderbolt uses PostHog for analytics to track user interactions and application usage. All events follow a structured naming convention for better organization and analysis.

### Event Naming Convention

Events follow the pattern: `<feature>_<action>`

- **Feature**: The main area of the application (e.g., `chat`, `task`, `automation`)
- **Action**: The specific action being performed (e.g., `send_prompt`, `add`, `create`)

### Event Categories

#### Chat & Messaging (`chat_*`)

- `chat_send_prompt` - User sends a message to the AI
- `chat_receive_reply` - AI generates a response
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

- `content_view_open` - Content view opens (with properties: `view_type`, `tool_name` for object views, `sideview_type` for sideviews)
- `content_view_close` - Content view closes (with property: `view_type`)
- `preview_open` - Preview webview opens from a link click
- `preview_close` - Preview webview closes
- `preview_copy_url` - User copies URL from preview header
- `preview_open_external` - User opens preview URL in external browser

#### UI & Navigation (`ui_*`)

- `ui_shortcut_use` - User uses a keyboard shortcut
- `ui_sidebar_open` - Sidebar opens
- `ui_sidebar_close` - Sidebar closes

### Implementation

Events are tracked using the `trackEvent` function from `src/lib/posthog.tsx`:

```typescript
import { trackEvent } from '@/lib/posthog'

// Track a simple event
trackEvent('chat_send_prompt')

// Track an event with properties
trackEvent('chat_send_prompt', {
  model: 'gpt-4',
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

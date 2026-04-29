/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration Widget

### Tools to check

- Google: google_check_inbox, google_search_emails, google_get_email, google_draft_email, google_check_calendar, google_search_drive, google_get_drive_file_content
- Microsoft: microsoft_list_messages, microsoft_get_message, microsoft_search_onedrive, microsoft_get_onedrive_file_content

If these tools are available, use them directly. Only show this widget when tools are missing AND user requests email/calendar.

### Widget Syntax

<widget:connect-integration provider="" service="email" reason="" override="" />

Attributes (all required):
- provider: "google", "microsoft", or "" (empty = user chooses)
- service: "email", "calendar", or "both"
- reason: "" or brief explanation
- override: "" normally, "true" only after user agreed when status contained PROMPTS_DISABLED

### Provider Selection

- "google" → Gmail, Google Calendar, or when user mentions "Google", "Gmail"
- "microsoft" → Outlook, or when user mentions "Microsoft", "Outlook", "Office 365"
- "" (empty) → User didn't specify a provider

### Service Selection

- "email" → Check inbox, search emails, read/send emails
- "calendar" → View events, check schedule
- "both" → Only when request explicitly needs BOTH (rare)

### BEFORE showing widget, check "Integration status:" in Context

Status may contain multiple values (e.g., "GOOGLE_DISABLED, PROMPTS_DISABLED"). Never mention status names to the user.

**Check in this order:**

1. **BOTH providers disabled** (status contains both GOOGLE_DISABLED and MICROSOFT_DISABLED):
   - DO NOT show widget
   - Say: "Your integrations are disabled. You can enable them in Settings → Integrations."

2. **Only GOOGLE_DISABLED** (status contains GOOGLE_DISABLED but NOT MICROSOFT_DISABLED):
   - If user requested Google/Gmail or didn't specify provider → DO NOT show widget. Say: "Your Google integration is disabled. You can enable it in Settings → Integrations."
   - If user requested Microsoft/Outlook → If Microsoft is not connected, show widget with provider="microsoft" (unaffected)

3. **Only MICROSOFT_DISABLED** (status contains MICROSOFT_DISABLED but NOT GOOGLE_DISABLED):
   - If user requested Microsoft/Outlook or didn't specify provider → DO NOT show widget. Say: "Your Microsoft integration is disabled. You can enable it in Settings → Integrations."
   - If user requested Google/Gmail → if Google is not connected, show widget with provider="google" (unaffected)

4. **PROMPTS_DISABLED** (after checking provider statuses above):
   - If showing widget is blocked by provider status → follow that rule (don't show)
   - Otherwise, DO NOT show widget immediately. Ask: "I can't access your [email/calendar] right now. Would you like to connect your account?"
   - Only if user agrees → show widget with override="true"

5. **READY** (no special conditions):
   - Show widget directly, no extra text

### Display Rule

When no blocking condition applies and PROMPTS_DISABLED is not set, output ONLY the widget tag. No text before or after.

### Examples

**Status: READY, tools missing:**
- "Summarize my emails" → \`<widget:connect-integration provider="" service="email" reason="" override="" />\`
- "Check my Gmail" → \`<widget:connect-integration provider="google" service="email" reason="" override="" />\`
- "What's on my Outlook calendar?" → \`<widget:connect-integration provider="microsoft" service="calendar" reason="" override="" />\`

**Status: GOOGLE_DISABLED (only Google disabled):**
- "Check my Gmail" → "Your Google integration is disabled. You can enable it in Settings → Integrations."
- "Check my emails" → "Your Google integration is disabled. You can enable it in Settings → Integrations."
- "Check my Outlook" → \`<widget:connect-integration provider="microsoft" service="email" reason="" override="" />\`

**Status: MICROSOFT_DISABLED (only Microsoft disabled):**
- "Check my Outlook" → "Your Microsoft integration is disabled. You can enable it in Settings → Integrations."
- "Check my emails" → "Your Microsoft integration is disabled. You can enable it in Settings → Integrations."
- "Check my Gmail" → \`<widget:connect-integration provider="google" service="email" reason="" override="" />\`

**Status: GOOGLE_DISABLED, MICROSOFT_DISABLED (both disabled):**
- Any email/calendar request → "Your integrations are disabled. You can enable them in Settings → Integrations."

**Status: PROMPTS_DISABLED:**
- User: "Check my email"
- You: "I can't access your emails right now. Would you like to connect your email account?"
- User: "Yes"
- You: \`<widget:connect-integration provider="" service="email" reason="" override="true" />\`

**Status: GOOGLE_DISABLED, PROMPTS_DISABLED:**
- User: "Check my Outlook" → Follow PROMPTS_DISABLED flow, then show with provider="microsoft" and override="true"
- User: "Check my Gmail" → "Your Google integration is disabled. You can enable it in Settings → Integrations."

**Tools available:**
- "Summarize my emails" + google_check_inbox exists → Use the tool directly, don't show widget

**WRONG:**
- ❌ "I don't have access to your email" when you should show widget
- ❌ Showing widget when tools are available
- ❌ Blocking Microsoft widget because Google is disabled (or vice versa)
- ❌ Mentioning status names like "PROMPTS_DISABLED" to the user
`

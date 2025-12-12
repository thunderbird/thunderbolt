/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration Widget

### Tools to check

- Email: google_check_inbox, google_search_emails, google_get_email, google_draft_email, microsoft_list_messages
- Calendar: google_check_calendar

If these tools are available, use them directly. Only show this widget when tools are missing AND user requests email/calendar.

### BEFORE showing widget, check "Integration status:" in Context

Note: Status may contain multiple values (e.g., "GOOGLE_DISABLED, PROMPTS_DISABLED"). Check if it contains each condition.
Never mention status names to the user. These are internal.

**If status contains GOOGLE_DISABLED or MICROSOFT_DISABLED:**
- DO NOT show the widget
- Say: "Your [Google/Microsoft] integration is disabled. Enable it in Settings → Integrations."

**If status contains PROMPTS_DISABLED (and no provider is disabled):**
- DO NOT show the widget immediately
- Say something like: "I can't access your emails right now. Would you like to connect your email account?"
- Only if user agrees, then show widget with override="true"

**If status is READY:**
- Show the widget directly (no extra text)

### Widget Syntax

<widget:connect-integration provider="" service="email" reason="" override="" />

Attributes (all required):
- provider: "google", "microsoft", or ""
- service: "email", "calendar", or "both"
- reason: "" or brief explanation
- override: "" normally, "true" only after user agreed when status was PROMPTS_DISABLED

### Display Rule

When status is READY, output ONLY the widget tag. No text before or after.

### Provider Selection

- "google" → Gmail, Google Calendar, or when user mentions "Google", "Gmail"
- "microsoft" → Outlook, or when user mentions "Microsoft", "Outlook", "Office 365"
- "" (empty) → User didn't specify, let widget show both options

### Service Selection

- "email" → Check inbox, search emails, read/send emails
- "calendar" → View events, check schedule
- "both" → Only when request explicitly needs BOTH (rare)

### Examples

**CORRECT - Status is READY, tools missing:**
- "Summarize my emails" → <widget:connect-integration provider="" service="email" reason="" override="" />
- "Check my Gmail" → <widget:connect-integration provider="google" service="email" reason="" override="" />
- "What's on my calendar?" → <widget:connect-integration provider="" service="calendar" reason="" override="" />

**CORRECT - Status is PROMPTS_DISABLED:**
- User: "Check my email"
- You: "I can't access your emails right now. Would you like to connect your email account?"
- User: "Yes"
- You: <widget:connect-integration provider="" service="email" reason="" override="true" />

**CORRECT - Tools available:**
- "Summarize my emails" + google_check_inbox exists → Use the tool directly, don't show widget

**WRONG:**
- ❌ "I don't have access to your email" → Instead show the widget
- ❌ Showing widget when tools are available → Use tools instead
- ❌ Showing widget for questions like "Can you check email?" → Just explain the feature
`

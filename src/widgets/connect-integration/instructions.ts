/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration Widget

If email/calendar tools (google_check_inbox, microsoft_list_messages, etc.) are available, use them directly.

Only show this widget when tools are missing AND user requests email/calendar.

### BEFORE showing widget, check "Integration status:" in Context

Note: Never mention status names (READY, PROMPTS_DISABLED, etc.) to the user. These are internal.

**If status is PROMPTS_DISABLED:**
- DO NOT show the widget immediately
- DO NOT mention the status name to the user
- Say something like: "I can't access your emails right now. Would you like to connect your email account?"
- Only if user agrees, then show widget with override="true"

**If status is GOOGLE_DISABLED or MICROSOFT_DISABLED:**
- DO NOT show the widget
- Say: "Your [Google/Microsoft] integration is disabled. Enable it in Settings → Integrations."

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
`

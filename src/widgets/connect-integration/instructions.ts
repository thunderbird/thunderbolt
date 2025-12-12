/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration Widget

Use this widget to prompt users to connect email/calendar integrations.

### When to use

1. **Check if tools are available first** - If email/calendar tools exist, use them directly
2. **Only show widget when**: tools are missing AND user requests email/calendar functionality

### Before showing widget, check "Connected integrations:" in Context

- **"[provider]: disabled"** → Don't show widget. Tell user: "Your [Provider] integration is disabled. Enable it in Settings → Integrations."
- **"prompts suppressed"** → Don't show widget immediately. Ask: "I can't access your emails right now. Would you like to connect your email account?" If user agrees, show widget with override="true"
- **Otherwise** → Show the widget directly (no extra text needed)

### Widget syntax

<widget:connect-integration provider="" service="email" reason="" override="" />

- **provider**: "google", "microsoft", or "" (empty = let user choose)
- **service**: "email", "calendar", or "both"
- **reason**: "" or brief explanation
- **override**: "" normally, "true" only after user agreed when prompts were suppressed

### Provider selection

- "google" → Gmail, Google Calendar, mentions of "Google", "Gmail"
- "microsoft" → Outlook, mentions of "Microsoft", "Outlook", "Office 365"
- "" → User didn't specify, show both options

### Examples

**Tools missing, no blockers:**
- "Summarize my emails" → <widget:connect-integration provider="" service="email" reason="" override="" />
- "Check my Gmail" → <widget:connect-integration provider="google" service="email" reason="" override="" />

**Prompts suppressed:**
- User: "Check my email"
- You: "I can't access your emails right now. Would you like to connect?"
- User: "Yes"
- You: <widget:connect-integration provider="" service="email" reason="" override="true" />

**Tools available:**
- Use tools directly, don't show widget
`

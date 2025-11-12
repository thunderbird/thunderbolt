/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration

<widget:connect-integration provider="google" service="calendar" reason="to view your upcoming events" />

All attributes are required. Use empty string ("") for provider when not specified, and empty string for reason when using default message.

### Tools to use

- For email: Check if "google_check_inbox", "google_search_emails", "google_get_email", "google_draft_email", or "microsoft_list_messages" are available

- For calendar: Check if "google_check_calendar" is available (Microsoft calendar tools may not exist yet)

**IMPORTANT:** If you see these tools in your available tools list, the integration is connected. Use the tools directly instead of showing the widget.

### Display Behavior

CRITICAL: When showing this widget, display ONLY the widget tag - do not add any introductory text, explanations, or messages before or after it. The widget itself contains all necessary information for the user.

NEVER include text like:
- "Here's a widget to connect..."
- "I'll help you connect..."
- "You need to connect..."
- Any text before or after the widget tag

ONLY output the widget tag itself, nothing else.

### Use this widget when:

1. User requests email/calendar functionality AND the required tool is missing from your available tools list

2. User explicitly asks to use a feature (not just asking about it)

3. You need tools like:

   - google_check_inbox, google_search_emails, google_get_email, google_draft_email (Google email)
   - google_check_calendar (Google calendar)
   - microsoft_list_messages, microsoft_get_message (Microsoft email)

**CRITICAL:** If you don't have access to the required email/calendar tools, you MUST show this widget to connect the integration. DO NOT explain that you don't have access - show the widget instead.

### DO NOT use this widget if:

- Tool is already available in your tool list (integration is connected and enabled) → Use the tool directly

- User is just exploring/asking about features: "What can you do with Gmail?", "Can you check email?", "How does email integration work?"

- User is asking for general help or information

- User mentions integrations but doesn't want to use them right now: "Maybe later", "I'll connect it myself", "Just wondering"

- The request doesn't require an integration (general questions, non-email/calendar tasks)

**IMPORTANT:** If tools are missing, DO NOT say "I don't have access" or "I cannot fetch" - show the widget instead.

### Provider Selection:

- "google" → For Gmail or Google Calendar requests, or when user mentions "Google", "Gmail", "Google Calendar"
- "microsoft" → For Outlook or Microsoft Calendar requests, or when user mentions "Microsoft", "Outlook", "MS", "Office 365"
- If user doesn't specify provider: Use provider="" (empty string) - the widget will automatically:
  - Use the single connected integration if only one is available
  - Show both options if both are connected or neither is connected

### Service Types:

- "email" → For email-only requests (check inbox, search emails, read/send emails)
- "calendar" → For calendar-only requests (view events, check schedule)
- "both" → ONLY when the request explicitly requires BOTH email AND calendar in a single action (rare)

Most requests are either email OR calendar, not both. Use "both" sparingly:

- "Show me emails and my calendar events for today" → service="both"
- "Check my email" → service="email" (not "both")
- "What's on my calendar?" → service="calendar" (not "both")

### Examples:

CORRECT - Tool missing, user wants to use feature:

- "Summarize my last 10 emails" → Tool not available, user didn't specify provider → <widget:connect-integration provider="" service="email" reason="" />
- "What's on my calendar today?" → Tool not available, user didn't specify provider → <widget:connect-integration provider="" service="calendar" reason="" />
- "Check my Gmail inbox" → Tool not available, user specified Gmail → <widget:connect-integration provider="google" service="email" reason="to check your inbox" />
- "Show me my Outlook emails" → Tool not available, user specified Outlook → <widget:connect-integration provider="microsoft" service="email" reason="" />

WRONG - Tool missing but explaining instead of showing widget:

- "Summarize my last 10 emails" → Tool not available → ❌ "I don't have access to your email" or "I cannot fetch emails" → Instead: Show widget <widget:connect-integration provider="" service="email" reason="" />

CORRECT - Tool already available, use tool directly:
- "Summarize my last 10 emails" → Tool "google_check_inbox" exists in your tools → Call google_check_inbox tool directly, do NOT show widget

WRONG - User just asking questions:

- "Can you check email?" → User asking about capability → Explain feature, don't show widget
- "What email providers do you support?" → Informational question → Answer without widget
- "How do I connect Gmail?" → User asking how → Explain process, don't show widget automatically

WRONG - Tool already available:
- "Summarize my last 10 emails" → Tool "google_check_inbox" exists → Use the tool, don't show widget
`

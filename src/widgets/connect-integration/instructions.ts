/**
 * AI Instructions for the connect-integration widget
 */
export const instructions = `## Connect Integration

<widget:connect-integration provider="google" service="calendar" reason="to view your upcoming events" />

### CRITICAL: Always Check Available Tools First
Before showing this widget, you MUST check if the required tool exists in your available tools:
- For email: Check if "google_check_inbox", "google_search_emails", "google_get_email", "google_draft_email", or "microsoft_list_messages" are available
- For calendar: Check if "google_check_calendar" is available (Microsoft calendar tools may not exist yet)
- Only show the widget if the required tool is NOT in your available tools list

### Display Behavior
CRITICAL: When showing this widget, display ONLY the widget tag - do not add any introductory text, explanations, or messages before or after it. The widget itself contains all necessary information for the user.

NEVER include text like:
- "Here's a widget to connect..."
- "I'll help you connect..."
- "You need to connect..."
- Any text before or after the widget tag

ONLY output the widget tag itself, nothing else.

### Use this widget when:
1. User requests email/calendar functionality AND the required tool is missing
2. User explicitly asks to use a feature (not just asking about it)
3. You need tools like:
   - google_check_inbox, google_search_emails, google_get_email, google_draft_email (Google email)
   - google_check_calendar (Google calendar)
   - microsoft_list_messages, microsoft_get_message (Microsoft email)

### DO NOT use this widget if:
- Tool is already available in your tool list (integration is connected and enabled)
- User is just exploring/asking about features: "What can you do with Gmail?", "Can you check email?", "How does email integration work?"
- User is asking for general help or information
- User mentions integrations but doesn't want to use them right now: "Maybe later", "I'll connect it myself", "Just wondering"
- The request doesn't require an integration (general questions, non-email/calendar tasks)

### Provider Selection:
- "google" → For Gmail or Google Calendar requests, or when user mentions "Google", "Gmail", "Google Calendar"
- "microsoft" → For Outlook or Microsoft Calendar requests, or when user mentions "Microsoft", "Outlook", "MS", "Office 365"
- If user doesn't specify provider: Omit the provider attribute entirely - the widget will automatically:
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
- "Summarize my last 10 emails" → Tool not available, user didn't specify provider → Show widget without provider (user chooses): <widget:connect-integration service="email" />
- "What's on my calendar today?" → Tool not available, user didn't specify provider → Show widget without provider: <widget:connect-integration service="calendar" />
- "Check my Gmail inbox" → Tool not available, user specified Gmail → Show widget with provider: <widget:connect-integration provider="google" service="email" reason="to check your inbox" />
- "Show me my Outlook emails" → Tool not available, user specified Outlook → Show widget with provider: <widget:connect-integration provider="microsoft" service="email" />

WRONG - Tool already available:
- "Summarize my last 10 emails" → Tool "google_check_inbox" exists → Use the tool, don't show widget

WRONG - User just asking questions:
- "Can you check email?" → User asking about capability → Explain feature, don't show widget
- "What email providers do you support?" → Informational question → Answer without widget
- "How do I connect Gmail?" → User asking how → Explain process, don't show widget automatically`

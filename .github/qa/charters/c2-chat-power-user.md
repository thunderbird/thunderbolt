# c2-chat-power-user: heavy chat use

Goal: long and messy chat sessions keep working.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5").

1. A thread of at least 12 messages, including a 2,000-character prompt and one with Markdown and code. Scroll up and
   down.
   Function: `long-thread`.
2. Stop a reply mid-stream, then send again. Retry or regenerate a reply if the UI offers it.
   Functions: `stop-reply`, `regenerate`.
3. Start several chats. Rename one (also to an empty and a 300-character name), delete one, then clear all chats.
   Reload after each change. Functions: `chat-rename`, `chat-delete`, `chat-clear-all`.
4. Search: open the search palette, search for words from earlier messages, open a result. Function: `search`.
5. Quote or reply to part of an earlier message if the UI offers it. Function: `quote-reply`.
6. Attachments: attach `.github/qa/fixtures/sample.pdf` and `.github/qa/fixtures/sample.png` with
   `browser_file_upload`, send them, open them from the thread. Also remove an attachment before sending.
   Functions: `attach-files`, `attach-remove`.
7. Select "GLM 5.3 Flash" once and send a message: an error is expected here. Check that the app says so and
   recovers when you switch back to "Opus 5". Function: `model-error`.

Out of bounds: settings, skills, projects, account deletion.

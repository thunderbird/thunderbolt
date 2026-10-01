# c2-chat-power-user: heavy chat use

Goal: long and messy chat sessions keep working.

Start state: fresh user, desktop viewport, fake AI (select "Opus 5").

1. A thread of at least 12 messages, including one very long prompt and one with Markdown and code. Scroll up and down.
2. Stop a reply mid-stream, then send again. Retry or regenerate a reply if the UI offers it.
3. Start several chats. Rename one (also to an empty and a 300-character name), delete one, then clear all chats.
   Reload after each change.
4. Search: open the search palette, search for words from earlier messages, open a result.
5. Quote or reply to part of an earlier message if the UI offers it.
6. Attachments: attach `.github/qa/fixtures/sample.pdf` and `.github/qa/fixtures/sample.png` with
   `browser_file_upload`, send them, open them from the thread. Also remove an attachment before sending.
7. Select "GLM 5.3 Flash" once and send a message: an error is expected here. Check that the app says so and
   recovers when you switch back to "Opus 5".

Out of bounds: settings, skills, projects, account deletion.

# c2-chat-power-user: heavy chat use

Goal: long and messy chat sessions keep working.

Start state: fresh user, fake AI (select "Opus 5.5").

1. A thread of at least 12 messages, including a 2,000-character prompt and one with Markdown and code. Scroll up and
   down.
   Function: `long-thread`.
2. Change course while a reply streams. A message with `qa:slow` gets its reply one word every 3 s: send one, press
   Stop within a few words, then send a plain message. The stopped reply keeps the words it showed, the new message
   gets exactly one full reply, and both stay as they were after a reload. Never wait for a slow reply to finish (it
   takes 30 s). Then send a message with `qa:cut` and a word you have not used before: the fake drops the connection
   after three words, and the app must retry or offer Retry until one full reply takes the partial one's place. The
   fake cuts each text only once, so a repro must change it on every run: a spec adds `${Date.now()}` to the message,
   and a flow types the message, then `${EMAIL}` (a fresh address per run) as its own `inputText`, before sending. On
   a device, check only the new message's reply and the retried reply: replay rewrites a flow's partial fake reply to
   the full one, so a flow cannot assert the stopped words. Functions: `stop-reply`, `retry-partial`.
3. Start several chats. Rename one (also to an empty and a 300-character name), delete one, then clear all chats.
   Reload after each change. Functions: `chat-rename`, `chat-delete`, `chat-clear-all`.
4. Search: open the search palette, search for words from earlier messages, open a result. Function: `search`.
5. Quote or reply to part of an earlier message if the UI offers it. Function: `quote-reply`.
6. Attachments: attach `.github/qa/fixtures/sample.pdf` and `.github/qa/fixtures/sample.png` with
   `browser_file_upload`, send them, open them from the thread. Also remove an attachment before sending.
   Functions: `attach-files`, `attach-remove`.
7. Open and close the sidebar: it is a drawer on a phone and a collapsible panel on a wide screen. Check that the chat
   list stays usable each time. Function: `sidebar-toggle`.
8. Select "DeepSeek V4.1 Flash" once and send a message: an error is expected here. Check that the app says so
   and recovers when you switch back to "Opus 5.5". Function: `model-error`.

Out of bounds: settings, skills, projects, account deletion.

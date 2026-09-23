# Chat

Chat is the main surface in Thunderbolt: pick a model, type a prompt, attach files, get an answer with sources.

Unsent text is kept per conversation, so switching chats and coming back does not lose a draft. A stopped reply is kept as far as it got; nothing is discarded. To quote part of an answer, select the text and click **Reply**, and the passage is added to the composer as a quote chip.

## Choosing a model

The model picker lists every model configured under **Settings → Models**.

- Switching models applies to the conversation you are in and becomes the default for new chats.
- A model whose provider key is not configured is shown as **API key not configured** and cannot be selected.
- Some models are marked **Private**. These run in a hardware enclave the app verifies before sending, so the server relaying the request cannot read it. A chat started on one is locked to that mode: ordinary models are greyed out inside it, and private models are greyed out in an ordinary chat. Start a new chat to switch modes. See [Models and providers](../customize.md#models).
- If the conversation is handed to an external agent rather than a built-in model, the picker is hidden: that agent chooses its own model.

Models that show their working display a collapsible **Thought for …** block above the answer. The reasoning is part of the saved message.

## Skills and slash commands

Skills are reusable instructions. Pinned skills appear as chips in the composer, and typing `/` lists everything available, including commands published by a connected external agent.

Two built-in skills change how much the model looks things up on the web:

| Skill       | Intended for                        | Web lookups per reply |
| ----------- | ----------------------------------- | --------------------- |
| (none)      | Normal questions                    | Up to 5               |
| `/search`   | Current events, products, places    | Up to 12              |
| `/research` | Exhaustive, multi-source deep dives | Up to 30              |

The allowance is one pool per reply, shared between searches and pages read, and repeated lookups of the same query or page are not counted twice. When it runs out the model is told and finishes with what it has, rather than failing. Each new message starts with a fresh allowance.

Skills are managed under **Settings → Skills**, where you can write your own. See [Skills](./skills.md).

## Attaching files

Attach with the paperclip, by dragging onto the composer, or by pasting a file from the clipboard.

### Accepted types and limits

| Type         | Extensions                                  |
| ------------ | ------------------------------------------- |
| Documents    | `.pdf`, `.docx`                             |
| Spreadsheets | `.xlsx`                                     |
| Images       | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`    |
| Text         | `.md`, `.markdown`, `.txt`, `.csv`, `.json` |

| Limit             | Value                                        |
| ----------------- | -------------------------------------------- |
| Files per message | 10                                           |
| Size per file     | 25 MB, measured after Thunderbolt shrinks it |

Large photos are downscaled before the size check, so a 30 MB phone picture usually attaches instead of being rejected. PDFs are re-saved losslessly. Animated GIFs are left untouched so the animation survives.

Anything else, including `.doc`, `.xls`, `.pptx`, audio and video, is rejected at the composer with a message naming the file.

### Where the bytes go

**File contents never leave the device except inside the request that answers your message.** Thunderbolt stores them in the browser or app's local storage and sends them to the model provider, or the external agent, that answers the message. No copy is kept on the Thunderbolt server.

Three consequences worth knowing before you rely on attachments:

- **Attachments do not follow a conversation to your other devices.** The message and the filename sync; the file itself does not. On a second device the model is told a file was attached and that it is unavailable there.
- **Attachments are not included in a data export.** Export carries your conversations, not the files you attached to them.
- **Nothing inside the app removes an attached file once it has been sent.** Deleting the conversation, signing out and deleting your account all leave it in local storage. Clearing site data (browser) or removing the app (desktop and mobile) is what clears it.

### How a file reaches the model

Thunderbolt sends the file in its original form where the model supports it, and converts otherwise. Spreadsheets and plain text are always converted to text, since no provider accepts a spreadsheet directly.

If a model rejects a file that was sent in its original form, Thunderbolt converts it and retries automatically: first to extracted text, then, for a PDF that holds no text to extract, to one image per page for the first 10 pages. You do not have to do anything.

After a conversion the file card offers **Resend as text** and **Resend as images** if you want to force the other form. When nothing is left to try, the error says the model could not read the file and suggests a different model.

Two gaps. Scanned PDFs are not put through text recognition (OCR); they go to the model as page images instead, which needs a model that can read images. And an image a model rejects has no fallback, so the error appears straight away.

Only the newest message's attachments are sent at full fidelity. Files from earlier turns in the same conversation are replaced by their extracted text, which keeps a long thread from resending megabytes on every reply.

## Web search and citations

Web search and page fetching come from the **Thunderbolt** connection under **Settings → Connections**, and require a Thunderbolt Pro subscription. Without Pro the assistant is never given these tools, and the connection shows Get Pro rather than a switch. With Pro you can switch it off there, and chats then cannot reach the web at all. On a self-hosted deployment search also needs a provider key on the server, so if it never returns results, check with whoever runs your deployment. See [Configuration](../self-hosting/configuration.md).

When the model uses a source, the answer carries a numbered badge like `[1]` at the point it is relevant. Click a badge to see the pages behind it, each with its title and link.

- Numbers are stable for the whole reply. A page found by search and then read keeps its number.
- Citations are saved with the message, so they still resolve when you reopen the conversation days later.
- A source is a real URL the model retrieved. Thunderbolt does not fabricate a citation list from the model's own text.

Clicking a link opens it according to your **External Links** preference. See [In-App Browser](../features/webview.md).

## Artifacts

An artifact is a self-contained web page the model writes when a chart, table, diagram or small interactive tool answers better than prose. It appears as a card in the conversation and can be opened in a side panel. You can copy its source or download it as a single `.html` file that opens in any browser. Artifacts are saved with the conversation and sync with it.

How they are contained:

- An artifact runs in an isolated frame with **no network access**. It cannot fetch data, load a remote script or stylesheet, submit a form, or read anything else in the app. Images and fonts have to be embedded in the page itself.
- Thunderbolt checks the page for errors before showing it, and asks the model to fix it if the check fails.
- Because the model wrote the code, never type a password, key or other secret into an artifact.

## When a reply fails

| What you see                | What it means                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reply retries on its own    | A transient failure. Thunderbolt retries up to 3 times with a growing delay                                                                                   |
| **Retry** button            | Automatic retries are done or were not appropriate. Click to run the turn again                                                                               |
| **Too many requests**       | The provider rate-limited you. Retrying immediately makes it worse                                                                                            |
| **Context Window Exceeded** | The conversation plus your message is larger than the model's limit. Start a new chat, remove some attachments, or switch to a model with a larger window     |
| **AI usage limit reached**  | Your allowance on a metered deployment is spent. The message names the window, 5 hours or 7 days, and the allowance frees up when that window rolls over      |
| Agent connection lost       | An external agent dropped mid-turn. Thunderbolt does not retry it for you: the agent may already have carried out part of the work, and a retry can repeat it |

The **context window** is the amount of text a model can hold in mind at once, and a long conversation is sent back to it in full on every turn. On desktop, a small ring in the composer shows how much of it the conversation has used; hover it for the figure. If your next message would not fit, Thunderbolt says so before sending rather than failing mid-reply.

Each reply also has a built-in ceiling on how many requests it may make to the provider and how long it may run (two minutes), so a stuck loop cannot quietly spend your budget.

There is no way to edit a message you have already sent, and no button to regenerate a reply that succeeded. Ask a follow-up, or start a new chat.

## Organizing conversations

A conversation is titled automatically from your first message. The `⋯` menu on a chat in the sidebar renames it, deletes it, or moves it to a project, and you can also drag a chat onto a project. **Clear all chats** at the top of the chat list deletes every conversation.

**Projects** group related chats and add instructions every chat in the project inherits. A chat in a project can also search the project's other chats when the model needs earlier context. Deleting a project does not delete its chats; they are returned to the ungrouped list. See [Projects](./projects.md).

**Search** (`Cmd/Ctrl + K`) covers chats, messages, models, skills, agents, connections, devices, projects and tasks, and runs commands such as "New chat". It runs entirely on the device, works offline, and never sends your query anywhere. It matches on keywords rather than meaning, so a question phrased differently from the text you are looking for may miss. Try the words you actually wrote. See [Search](./search.md).

Conversations are stored on the device first. If sync is enabled they appear on your other devices, encrypted end to end when you turn that on. Deleting a chat removes it everywhere you are signed in.

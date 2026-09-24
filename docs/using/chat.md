# Chat

Chat is the main surface in Thunderbolt. You pick a model, a skill and any attachments, and the answer comes back with its sources.

To quote part of an answer, select the text and click **Reply**. The passage is added to the composer as a quote chip.

## Choosing a model

The model picker lists every model configured under **Settings → Models**, and applies to the built-in Thunderbolt agent only. Switching models applies to the conversation you are in and becomes the default for new chats.

A model whose provider key is not configured is shown as **API key not configured** and cannot be selected.

If an external agent is handling the conversation, the picker is hidden and nothing under **Settings → Models** reaches it. That agent runs whichever model it is configured with, at its end. Some let you switch models through their own commands or configuration, some offer no choice at all.

Some models are marked **Private**. These run in a hardware enclave the app verifies before sending, so the server relaying the request cannot read it. A chat started on one is locked to that mode: ordinary models are greyed out inside it, and private models are greyed out in an ordinary chat. Start a new chat to switch modes. See [Models and providers](../customize.md#models).

Models that show their working display a collapsible **Thought for …** block above the answer. The reasoning is part of the saved message.

## Skills and slash commands

Skills are reusable instructions. Pinned skills appear as chips in the composer, and typing `/` lists everything available, including commands published by a connected external agent.

Two built-in skills change how much the model looks things up on the web:

| Skill       | Intended for                        | Web lookups per reply |
| ----------- | ----------------------------------- | --------------------- |
| (none)      | Normal questions                    | Up to 5               |
| `/search`   | Current events, products, places    | Up to 12              |
| `/research` | Exhaustive, multi-source deep dives | Up to 30              |

The allowance is one pool per reply, shared between searches and pages read, and repeated lookups of the same query or page are not counted twice. When it runs out, the model is told and finishes with what it has. Each new message starts with a fresh allowance. If the assistant loads `/research` on its own mid-reply, that reply's allowance rises to 30.

Skills are managed under **Settings → Skills**, where you can write your own. See [Skills](./skills.md).

## Attaching files

### Accepted types and limits

| Type         | Extensions                                  |
| ------------ | ------------------------------------------- |
| Documents    | `.pdf`, `.docx`                             |
| Spreadsheets | `.xlsx`                                     |
| Images       | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`    |
| Text         | `.md`, `.markdown`, `.txt`, `.csv`, `.json` |

A message carries up to 10 files, each up to 25 MB as measured after Thunderbolt shrinks it. Only files over 10 MB are shrunk at all: a large photo is re-encoded as WebP, which loses some quality, and a PDF is re-saved losslessly. GIFs are never touched, so animation survives. A 30 MB phone picture usually attaches; an 8 MB one is sent exactly as it is.

Anything else, including `.doc`, `.xls`, `.pptx`, audio and video, is rejected at the composer with a message naming the file.

### Where the bytes go

Thunderbolt stores file contents in the browser or app's local storage and sends them to the model provider, or the external agent, that answers the message. No copy is kept on the Thunderbolt server.

> File contents never leave the device except inside the request that answers your message.

Three consequences follow:

- Attachments do not follow a conversation to your other devices. The message and the filename sync; the file itself does not. On a second device the model is told a file was attached and that it is unavailable there.
- Attachments are not included in a data export. Export carries your conversations, not the files you attached to them.
- Nothing inside the app removes an attached file once it has been sent. Deleting the conversation, signing out and deleting your account all leave it in local storage. Clearing site data (browser) or removing the app (desktop and mobile) is what clears it.

### How a file reaches the model

Images go to the model as images. Every document (PDF, `.docx`, spreadsheet, plain text) is converted to text on your device first, because the assistant has no way to carry a document as a document. A model with tool usage turned off in its tuning is the exception: it takes an older path that can send a PDF as a file.

A scanned PDF is the case to watch. It has no text layer to extract and there is no text recognition (OCR) step, so the assistant receives the filename and nothing else. Screenshot the page you care about and attach that instead.

Only the newest message's attachments are sent at full fidelity. Files from earlier turns in the same conversation are replaced by their extracted text, which keeps a long thread from resending megabytes on every reply.

## Web search and citations

Web search and page fetching come from the **Thunderbolt** connection under **Settings → Connections**, which is on by default. Switch it off there and chats cannot reach the web at all. The tools also need a search provider key on the server, so if they never return results, check with whoever runs your deployment. See [Configuration](../self-hosting/configuration.md).

When the model uses a source, the answer carries a numbered badge like `[1]` at the point it is relevant. Click a badge to see the pages behind it, each with its title and link. Numbers are stable for the whole reply: a page found by search and then read keeps its number.

Citations are saved with the message, so they still resolve when you reopen the conversation days later. Every source is a real URL the model retrieved. We never assemble a citation list from the model's own text.

Clicking a link opens it according to your **External Links** preference. See [In-App Browser](../features/webview.md).

## Artifacts

An artifact is a self-contained web page the model writes when a chart, table, diagram or small interactive tool answers better than prose. It appears as a card in the conversation and opens in a side panel, and you can download it as a single `.html` file. Artifacts are saved with the conversation and sync with it.

An artifact runs in an isolated frame that cannot fetch data, load a remote script or stylesheet, submit a form, or read anything else in the app. Images and fonts have to be embedded in the page itself. Thunderbolt checks the page for errors before showing it, and asks the model to fix it if the check fails.

> An artifact is code the model wrote. Don't type a password, key or other secret into one.

## When a reply fails

| What you see                | What it means                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reply retries on its own    | A transient failure. Thunderbolt retries up to 3 times with a growing delay                                                                                                                   |
| **Retry** button            | Automatic retries are done or were not appropriate. Click to run the turn again                                                                                                               |
| **Too many requests**       | The provider rate-limited you. Retrying immediately makes it worse                                                                                                                            |
| **Context Window Exceeded** | The conversation plus your message is larger than the model's limit. Start a new chat, remove some attachments, or switch to a model with a larger window                                     |
| **AI usage limit reached**  | Your allowance on a metered deployment is spent. The message names the window, 5 hours or 7 days. Both windows roll continuously, so the allowance frees up gradually as older usage ages out |
| Agent connection lost       | An external agent dropped mid-turn. Thunderbolt does not retry it for you: the agent may already have carried out part of the work, and a retry can repeat it                                 |

The **context window** is the amount of text a model can hold in mind at once, and a long conversation is sent back to it in full on every turn. On desktop, a small ring in the composer shows how much of it the conversation has used; hover it for the figure. If your next message would not fit, Thunderbolt says so before sending rather than failing mid-reply.

Each reply also has a built-in ceiling on how many requests it may make to the provider and how long it may run (two minutes), so a stuck loop cannot quietly spend your budget.

There is no way to edit a message you have already sent, and no button to regenerate a reply that succeeded. Ask a follow-up, or start a new chat.

## Organizing conversations

A conversation is titled automatically from your first message. Drag a chat onto a project in the sidebar to file it there, or use **Move to project** in its `⋯` menu.

Projects group related chats and add instructions every chat in the project inherits. A chat in a project can also search the project's other chats when the model needs earlier context. Deleting a project does not delete its chats; they are returned to the ungrouped list. See [Projects](./projects.md).

Search (`Cmd/Ctrl + K`) runs entirely on the device, so your query is never sent anywhere. Matching is on keywords rather than meaning: try the wording you used at the time. See [Search](./search.md).

Conversations are stored on the device first. If sync is enabled they appear on your other devices, encrypted end to end when you turn that on. Deleting a chat removes it everywhere you are signed in.

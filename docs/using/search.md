# Search and the Command Palette

One box finds everything in Thunderbolt: chats, messages, projects, skills, models, agents, connections and devices. It also runs commands, so you can jump to a settings page or start a new chat without touching the mouse. Search runs on the device against an index the app builds locally. No query is sent to a server, and it works offline.

## Opening it

`Cmd+K` anywhere in the app, `Ctrl+K` on Windows and Linux.

## What is searchable

| Group       | Matched on                                                                          |
| ----------- | ----------------------------------------------------------------------------------- |
| Chats       | Chat title                                                                          |
| Messages    | Message text only, not reasoning, tool results, artifacts or attached file contents |
| Projects    | Name, description, project instructions                                             |
| Skills      | Name, description, instructions                                                     |
| Models      | Name, description, vendor, model id                                                 |
| Agents      | Name, description, for agents you added                                             |
| Connections | Server name, URL or command                                                         |
| Devices     | Device name                                                                         |
| Tasks       | Task text (only when Tasks is turned on)                                            |

Titles rank well above body text, so a chat called "Invoices" beats a message that mentions invoices in passing. Results are grouped by category in a fixed order and capped at 50 per query.

## What is never indexed

Anything put in the index is stored as plain readable text on the device, so some data is deliberately kept out:

- API keys, tokens and every other stored credential
- Settings values and model profiles
- Saved prompts and their schedules

Each device builds its own index from the data it holds and only finds what has already synced to it. That index is never uploaded or shared between devices.

## Commands

With the box empty, the palette lists actions instead of content.

| Group   | Includes                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------- |
| Create  | New chat, Create Model, Create Skill, Create Agent                                                 |
| Go to   | All agents, Skills, Connections, Models, Preferences, Devices, plus Voice and Tasks when turned on |
| Actions | Set Light, Set Dark, Use System, Toggle sidebar, Sign out, Clear all chats                         |

Commands match on their name and on keywords, so `mcp` finds Connections, `llm` finds Models, `sync` finds Devices, and `logout` finds Sign out. A **Download app** command joins the Actions group when you are running Thunderbolt in a desktop browser and the deployment publishes desktop builds.

## Where a result takes you

A message result opens its chat scrolled to that message, and a model, skill or agent opens its edit panel. Built-in models cannot be edited, so they open the Models list instead. The palette never offers to delete an individual item; deletion stays on that item's own menu.

## Matching and languages

- **Case and accent insensitive:** `parametres` finds "Paramètres", `gerate` finds "Geräte".
- **Prefix matching:** `invo` finds "invoice" and "invoicing", but not the middle of a word.
- **Every term must match:** two words narrow the result set rather than widen it.
- **Japanese, Chinese, Thai, Lao, Khmer and Burmese:** matched anywhere inside a word, at any length, including one and two character queries, because those scripts do not separate words with spaces.

The index does not follow the app's display language. Your content can mix languages freely, and switching the interface language never changes or rebuilds search results.

## Keyword search, not semantic search

We ship no embedding model and no vector database, so a query phrased differently from the original text will miss. Retry with the words you would actually have typed at the time.

## Searching inside a project

Inside a project, the assistant can search the other chats in that same project and quote excerpts back to you, so you can ask about something discussed in a sibling thread. It uses the same local index, skips the current chat because that history is already in front of the model, and returns at most eight excerpts per search. Keyword matching still applies here: if the model reports finding nothing, the wording may simply differ from the original conversation. See [Projects](./projects.md).

## Troubleshooting

| Symptom                                   | What to do                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Search returns nothing at all             | Reload the app. The index is rebuilt at startup whenever it is missing or out of date.           |
| Recent messages are missing               | Wait for sync to finish on that device, then search again.                                       |
| Results appear on one device, not another | The second device has not synced that data yet, or **Sync This Device With Cloud** is off there. |

The index holds no original data of its own, so it can be discarded and rebuilt at any time without losing anything. See [Apps and Sync](./apps-and-sync.md) for what replicates between devices.

> Finding things in your own data is separate from web search, which grounds model answers in external sources and is configured under **Settings → Connections**. See [Chat](./chat.md#web-search-and-citations).

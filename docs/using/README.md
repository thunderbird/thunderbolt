# Using Thunderbolt

Thunderbolt is a chat client for the AI models and agents you choose.

## Chats

A conversation is saved on the device as you go, and its title is taken from your first message. With sync on, deleting a chat reaches the other devices on the account. A message you have already sent cannot be edited, and a reply that succeeded cannot be regenerated; ask a follow-up instead.

[Chat](./chat.md) covers attachments, artifacts, citations, and what the app shows when a reply fails.

## Models and agents

Each conversation keeps its own model and agent. The model picker sits in the composer and lists the models set up under Settings → Models. The agent picker sits at the top of the chat and offers the built-in Thunderbolt agent or an external agent you connected. An external agent brings its own model, so the model picker is hidden while one is selected.

Adding models and providers is covered in [Customize](../customize.md).

## Projects

A project is a set of instructions that every chat inside it inherits, plus a view of the chats that belong to it. Deleting a project keeps its chats.

The assistant can keyword-search the project's other conversations when it needs earlier context, so wording that differs from the original chat can miss. Projects do not hold an uploaded document set; files are attached per message, in the chat that needs them. See [Projects](./projects.md).

## Skills

A skill is a named block of instructions. Type `/` or `@` in the composer to pick one for a single message, or let the assistant load one on its own when the request calls for it. Thunderbolt ships a set of skills, and you can add your own under Settings → Skills. Pin the ones you use most, up to ten, and they appear as chips above the composer when you start a chat. See [Skills](./skills.md).

## Connections

Settings → Connections is where the assistant gets tools beyond the ones built in.

| Connection            | What it adds                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Thunderbolt           | Web search and page fetching, with Thunderbolt Pro. Without Pro these tools are not offered                       |
| Google, Microsoft     | Read access to that account's mail, calendar, and files, once you sign in. Mail drafts can be created, never sent |
| An MCP server you add | Whatever tools that server publishes, such as searching a wiki, querying a database, or filing a ticket           |

MCP is the Model Context Protocol, an open standard for publishing tools to an AI assistant. You add a server by URL, and a test button lists the tools it offers before you save it. Every connection has its own on/off switch. Google and Microsoft also need whoever runs your deployment to have configured sign-in credentials for that provider.

External agents are separate and are added under Settings → Agents. [Connections](./connections.md) covers both.

## Voice

When the composer is empty, the send button becomes a voice button. Thunderbolt transcribes what you say, sends it as an ordinary message, and speaks the reply. Talking over the reply interrupts it. Only your finished utterance is sent; there is no live microphone stream, and audio is never stored. See [Voice](./voice.md).

## Search

`Cmd+K` on macOS or `Ctrl+K` elsewhere opens one box that searches chats, messages, models, skills, agents, connections, devices, projects, and tasks, and runs commands such as New chat or jumping to a settings page.

Search runs against an index on the device, so it works offline and no query leaves the machine. It matches words, not meaning: a question phrased differently from the text you are looking for will miss. See [Search](./search.md).

## Where settings live

| Page        | What you set there                                                                        |
| ----------- | ----------------------------------------------------------------------------------------- |
| Agents      | The agents available in the agent picker                                                  |
| Skills      | Create, edit, enable, and pin skills                                                      |
| Connections | MCP servers, external services, and the tools each one exposes                            |
| Models      | Providers, API keys, and which models appear in the picker                                |
| Voice       | The speech provider, when the voice preview is turned on                                  |
| Preferences | Appearance, your name, language and units, privacy, network proxy, sync, export, deletion |
| Devices     | The devices signed into the account, and revoking one                                     |

Your preferred name, location, language, units, and usage-data opt-in follow the account. Theme, haptics, link behaviour, and voice provider stay on this device, along with model API keys, MCP servers and their credentials, and whether this device syncs at all.

Attached files stay on the device that added them too: the message syncs, the file does not. [Apps and Sync](./apps-and-sync.md) describes what replicates between devices and how a new device is approved.

## Preview features

Tasks is a to-do list the assistant can also read and write. It is off by default and is enabled under Preferences → Preview Features, which adds a Tasks entry to the sidebar. Where a deployment has usage analytics configured, Tasks also requires anonymous usage data to be on, and turning that off turns Tasks off.

The custom voice provider and cross-device sync are in preview as well, and the optional end-to-end encryption that protects synced data has not had a cryptography audit. Everything else described here is on by default.

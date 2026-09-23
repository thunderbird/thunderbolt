# Using Thunderbolt

Thunderbolt is a chat client for the AI models and agents you choose.

## Chats

A conversation is saved on the device as you go, and its title is taken from your first message. With sync on, deleting a chat reaches the other devices on the account.

A message you have already sent cannot be edited, and a reply that succeeded cannot be regenerated. Ask a follow-up instead.

See [Chat](./chat.md) for attachments, artifacts, citations, and what the app shows when a reply fails.

## Models and agents

Two choices apply per conversation, and both stick to that conversation.

| Choice | Where           | Notes                                                              |
| ------ | --------------- | ------------------------------------------------------------------ |
| Model  | In the composer | Lists the models set up under Settings → Models                    |
| Agent  | Top of the chat | The built-in Thunderbolt agent, or an external agent you connected |

External agents bring their own model, so the model picker is hidden while one is selected. Adding models and providers is covered in [Customize](../customize.md).

## Projects

A project is a set of instructions that every chat inside it inherits, plus a view of the chats that belong to it. The assistant can keyword-search the project's other conversations when it needs earlier context, so wording that differs from the original chat can miss.

Projects do not hold an uploaded document set. Files are attached per message, in the chat that needs them. Deleting a project keeps its chats. See [Projects](./projects.md).

## Skills

A skill is a named block of instructions. Type `/` or `@` in the composer to pick one for a single message, or let the assistant load one on its own when the request calls for it.

Thunderbolt ships a set of skills and you can add your own under Settings → Skills. Pin the ones you use most, up to ten, and they appear as chips above the composer when you start a chat. See [Skills](./skills.md).

## Connections

Settings → Connections is where the assistant gets tools beyond the ones built in.

| Connection            | What it adds                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Thunderbolt           | Web search and page fetching, with Thunderbolt Pro. Without Pro these tools are not offered                       |
| Google, Microsoft     | Read access to that account's mail, calendar, and files, once you sign in. Mail drafts can be created, never sent |
| An MCP server you add | Whatever tools that server publishes, such as searching a wiki, querying a database, or filing a ticket           |

MCP is the Model Context Protocol, an open standard for publishing tools to an AI assistant. You add a server by URL, and a test button lists the tools it offers before you save it. Every connection has its own on/off switch. Google and Microsoft also need whoever runs your deployment to have configured sign-in credentials for that provider.

External agents are separate and are added under Settings → Agents. See [Connections](./connections.md) for both.

## Voice

When the composer is empty, the send button becomes a voice button. Thunderbolt transcribes what you say, sends it as an ordinary message, and speaks the reply. Talking over the reply interrupts it.

Only your finished utterance is sent, never a live microphone stream, and audio is never stored. See [Voice](./voice.md).

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

| Follows the account                                          | Stays on this device                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Preferred name, location, language, units, usage-data opt-in | Theme, haptics, link behaviour, voice provider, whether this device syncs at all, model API keys, MCP servers and their credentials |

Attached files stay on the device that added them too: the message syncs, the file does not. See [Apps and Sync](./apps-and-sync.md) for what replicates between devices and how a new device is approved.

## Preview features

Tasks is a to-do list the assistant can also read and write. It is off by default and is enabled under Preferences → Preview Features, which adds a Tasks entry to the sidebar. Where a deployment has usage analytics configured, Tasks also requires anonymous usage data to be on, and turning that off turns Tasks off.

The custom voice provider is a preview feature too. Cross-device sync is also in preview, and the optional end-to-end encryption that protects synced data has not had a cryptography audit. Everything else described here is on by default.

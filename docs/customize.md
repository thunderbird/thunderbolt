# Customize

Everything below is changed in the app under **Settings**, except the deployment-level switches at
the end.

| Settings page   | What you change there                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| **Agents**      | External agents that can answer a chat instead of the built-in assistant                |
| **Skills**      | Reusable instruction blocks, invoked with `/name` or picked by the model                |
| **Connections** | Tool servers (MCP), plus the ready-made Google and Microsoft integrations               |
| **Models**      | Which models are available, and the keys used to reach them                             |
| **Voice**       | The speech engine, when the custom voice preview is on                                  |
| **Preferences** | Theme, name, language, units, network and data controls                                 |
| **Devices**     | The devices signed in to the account, and revoking one. See [Devices](admin/devices.md) |

## What syncs and what does not

Models, skills, agents, projects, chats and most preferences follow you to every device. Add a model
on your laptop and it appears on your phone, though you will be asked for the key again there: no
credential of any kind is ever synced.

The rest stays on the device where you set it. That covers API keys and tokens, the MCP servers you
add, your Google and Microsoft authorizations, the theme, haptics, link-opening behaviour and speech
engine, the cloud proxy, and whether this device syncs at all. MCP servers are device-local in full,
the server entry as well as its secret, because an entry without its credential cannot connect.

Those device-local items reach a second device only through the export under
**Preferences → Data**, which includes them. See [Apps and sync](using/apps-and-sync.md).

## Models

### Providers

| Provider              | API key    | Endpoint URL | Notes                                                    |
| --------------------- | ---------- | ------------ | -------------------------------------------------------- |
| Thunderbolt (managed) | Not needed | Not needed   | Provided by your deployment, authenticated by the server |
| Anthropic             | Required   | Not needed   |                                                          |
| OpenAI                | Required   | Not needed   |                                                          |
| OpenRouter            | Required   | Not needed   |                                                          |
| Tinfoil               | Required   | Not needed   | Confidential inference in a verified hardware enclave    |
| Custom                | Optional   | Required     | Any OpenAI-compatible endpoint, on-prem or local         |

The **Custom** form pre-fills `http://localhost:11434/v1`, the usual address of a local Ollama
install. Leave the key blank if the endpoint does not need one.

### Adding a model

Where the provider publishes a catalog, the model list fills itself in. OpenAI, Anthropic and
OpenRouter need a valid key before their catalog loads, and you can always type the model identifier
by hand instead. Every provider except the managed Thunderbolt models must pass **Test Connection**
before the model can be saved.

### Models your deployment provides

If the operator configured managed inference, some models arrive already working, with no key, no
URL and no connection test for a user to get wrong.

Managed usage is metered per account against two rolling spending allowances, one over five hours
and one over seven days, and an anonymous session gets a much smaller allowance than a signed-in
account. Once an allowance is used up the app refuses the managed model and says so. Operators set
the four limits; see [Configuration](self-hosting/configuration.md) and
[Serving models](self-hosting/models.md). Models reached with a user's own key are never metered by
Thunderbolt.

Some managed models are **confidential**: the request is encrypted for a hardware enclave that the
app verifies before sending, so the server relaying it cannot read the conversation in either
direction. A chat started on a confidential model stays on confidential models.

### Editing the built-in models

The models Thunderbolt ships with are ordinary rows you can rename, re-point or delete, and your
edit persists: later app updates change only the models you have not touched. Two properties never
change on an existing model, whether you edit them or an update does: whether the model is
confidential, and which provider routes it.

## Agents

An agent is what actually answers a chat. Thunderbolt's built-in assistant is the default. You can
point a chat at an external agent instead, over the open [Agent Client
Protocol](https://agentclientprotocol.com), a published standard for connecting a chat client to an
agent that someone else runs.

Three kinds of agent can appear in the list. Thunderbolt's built-in assistant is always there unless
the operator disables it. Alongside it you may find agents your backend serves, which appear
automatically with nothing to configure, and any custom agent you added yourself in
**Settings → Agents**.

To add one, give it a name and either a WebSocket URL (`wss://…`) or a peer-to-peer connection
ticket, plus an optional description. A ticket is a long code the agent prints when it starts; it
identifies the agent directly, so no URL, hostname or open inbound port is involved.
**Test connection** checks a WebSocket endpoint; a ticket is verified on the first message instead.

An external agent brings its own commands, which appear in the chat `/` menu alongside your skills.

**Reaching an agent on your own machine.** The web app cannot connect to `localhost` or a private
network address. Browser rules force that traffic through the cloud proxy in your Thunderbolt
backend, and the relay refuses private targets; the desktop switch for the proxy does not lift the
restriction either, for the reason given under [Preferences](#preferences). Use the peer-to-peer
ticket instead of a URL.

More detail, including what each failure message means: [Connections](using/connections.md).

## Skills

A skill is a named block of instructions. Type `/name` in the composer to apply it to one message,
or let the model pull it in on its own when a request matches its description.

Create one in **Settings → Skills** with four fields:

| Field        | What it does                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| Name         | The display name, for example `Daily Brief`                                         |
| Slug         | The `/token` you type, for example `/daily-brief`                                   |
| Description  | The only thing the model reads when deciding whether to load the skill. Be specific |
| Instructions | The body the model receives once the skill is loaded                                |

Slugs are lowercase letters, digits and hyphens, up to 64 characters, with no hyphen at either end
and none doubled.

The model sees one line per enabled skill and fetches the body only when it decides that skill
applies. A vague description means the skill is never used.

Skills can be enabled, disabled, and pinned as chips above the composer, up to ten of them. A
handful of built-in skills define how Thunderbolt renders things like weather and maps in a reply:
those can be switched off but not edited or deleted, and once unpinned cannot be pinned again. Your
edits to a built-in skill are preserved when Thunderbolt updates its own copies. Worked examples:
[Skills](using/skills.md).

## Connections

**Settings → Connections** holds two different things.

**Integrations** are ready-made connections we supply. The Thunderbolt one gives the
assistant web search, page fetching and weather, and requires Thunderbolt Pro: without Pro the row
offers Get Pro and the assistant gets none of those tools, and with Pro you can switch the
integration off here. Google covers Gmail (read, search, draft) and Google Calendar; Microsoft
covers Outlook mail and OneDrive files. Both need you to authorize the account first.

Authorizing is per device, and so is switching an integration off.

**MCP servers** are yours to add. [Model Context Protocol](https://modelcontextprotocol.io) is an
open standard for exposing tools to an AI client, so an MCP server is a tool server: it publishes a
list of things the model can do, such as searching a wiki or filing a ticket. Every enabled server's
tools are merged into the model's toolset on each message. We ship a client only; there is no Thunderbolt MCP
server.

### Adding an MCP server

Give it a name, the server URL, and a credential if it needs one. The name prefixes every tool the
server provides, and the server cannot be saved until a connection test passes. Thunderbolt uses a
token or API key when you supply one and otherwise attempts OAuth, offering **Add & Authorize**
where the server supports it. When a server wants OAuth but cannot issue a client automatically, the
app tells you to supply a token. Servers that need re-authorization later say so on their card.

**Bulk import.** The **Advanced (JSON)** tab accepts the same `mcpServers` shape other MCP clients
use:

```json
{
  "mcpServers": {
    "Acme": {
      "url": "https://acme.example/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

`"type": "sse"` selects the legacy SSE transport for servers that only speak it.

### MCP limitations

- Servers that run as a local process are not supported. Entries with a `command` and `args` are
  rejected on import. Run such a server behind the Thunderbolt command-line bridge and connect to it
  peer-to-peer.
- `https` is required for any public host. Plain `http` is accepted only for `localhost` and private
  network addresses, which no released build can reach.
- Servers and their credentials are device-local. Adding a server on one machine does not add it
  anywhere else, though a data export carries them across on restore.
- Deleting a server deletes its stored credential with it.

> A plain `http` URL saves without complaint and then never connects. Use `https` for anything that
> is not on the machine in front of you.

## Projects

A project is a workspace with durable instructions that every chat inside it inherits, plus a tool
that lets the model search the project's other conversations. Chats stay isolated otherwise: one
never sees another's transcript unless the model goes looking. There is no project file or document
set.

Cross-chat search is keyword matching rather than meaning-based, so a question phrased differently
from the original conversation can miss. Retry with the words you actually used. See
[Projects](using/projects.md).

## Voice

Voice mode needs no configuration. It uses Thunderbolt's hosted speech engine, which runs
transcription and read-aloud inside the same kind of verified enclave as a confidential model.

Turning on **Custom voice provider** under Preferences adds a **Voice** settings page, where you can
point transcription and read-aloud at any OpenAI-compatible speech endpoint instead: a base URL
including its version prefix, an optional key, and a model for each of the two directions plus the
voice to speak in. The choice is per device. See [Voice](using/voice.md).

## Preferences

| Section                  | Controls                                                                            | Scope              |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------ |
| User Experience          | Theme (Light, Dark, System), where chat links open (Ask, Sidebar, Browser), haptics | This device        |
| Personalization          | Preferred name                                                                      | Your account       |
| Localization             | Location, language, distance, temperature, time format, currency                    | Your account       |
| Help Thunderbolt Improve | Preview features, anonymous usage data                                              | Your account       |
| Network                  | Use cloud proxy                                                                     | This device        |
| Data                     | Sync this device, export, import, delete local data, and delete the whole account   | Mostly this device |

Any preference you have changed from its shipped value shows a revert control next to it.

**Localization.** Setting a location seeds units, time format and currency from the conventions of
that region, and you can override any of them individually. Changing the language changes the
interface only; the model replies in the language of the conversation.

**Network.** The cloud proxy relays outbound traffic through the Thunderbolt backend. In a browser
it is always on, because browser security rules leave no alternative. The desktop app offers a
switch to turn it off, but the direct device-to-provider path it selects is not compiled into
released builds, so published desktop and mobile builds relay through the backend either way.

**Preview features** are opt-ins that sync to every device on the account, so switching one on in
one place switches it on everywhere. Today they cover tasks and the custom voice provider.

**Data.** Everything here is about this device, except **Delete Your Account**, which removes the
account and its data from the server as well.

## Deployment-level controls

An operator can restrict what users are allowed to customize. These are environment variables set
on the backend, not in-app settings, and changing one needs a restart. Full list:
[Configuration](self-hosting/configuration.md).

| Variable                                 | Default | Effect                                                                  |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `ALLOW_CUSTOM_AGENTS`                    | `true`  | `false` hides the add-agent control, leaving only agents you provide    |
| `DISABLE_BUILT_IN_AGENT`                 | `false` | `true` removes Thunderbolt's own assistant from the agent list          |
| `ENABLED_AGENTS`                         | empty   | Comma-separated list of the agent ids to offer. Empty means all of them |
| `ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY` | unset   | Enable the managed direct model tier                                    |
| `TINFOIL_API_KEY`                        | unset   | Enables the managed confidential model tier                             |

There is no server-side control over which models, skills or MCP servers an individual user adds
for themselves.

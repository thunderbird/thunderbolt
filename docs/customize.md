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

| Follows you to every device                                   | Stays on the one device                               |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| Models, skills, agents, projects, chats, and most preferences | API keys and tokens of every kind                     |
|                                                               | MCP servers (the server entry, not just its secret)   |
|                                                               | Google and Microsoft authorizations                   |
|                                                               | Theme, haptics, link-opening behaviour, speech engine |
|                                                               | Cloud proxy, and whether this device syncs at all     |

A credential is never synced. Add a model on your laptop and it appears on your phone, but you will
be asked for the key again there. MCP servers do not sync at all, because a server entry without
its credential cannot connect.

The one way to carry device-local items to another device is the export under **Preferences → Data**,
which includes them. See [Apps and sync](using/apps-and-sync.md).

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
OpenRouter need a valid key before their catalog loads; you can always type the model identifier by
hand instead.

Every provider except the managed Thunderbolt models must pass **Test Connection** before the model
can be saved. Editing a saved model shows the key as dots; leave it untouched to keep it.

### Models your deployment provides

If the operator configured managed inference, some models arrive already working and cannot be
misconfigured by a user: no key, no URL, no connection test.

Managed usage is metered per account against two rolling spending allowances, one over five hours
and one over seven days, with a much smaller allowance for anonymous sessions than for signed-in
accounts. A managed model is refused once an allowance is used up, and the app says so. Operators
set the four limits; see [Configuration](self-hosting/configuration.md) and
[Serving models](self-hosting/models.md). Models reached with a user's own key are never metered by
Thunderbolt.

Some managed models are **confidential**: the request is encrypted for a hardware enclave that the
app verifies before sending, so the server relaying it cannot read the conversation in either
direction. A chat started on a confidential model stays on confidential models.

### Editing the built-in models

The models Thunderbolt ships with are ordinary rows you can rename, re-point or delete. An edit
sticks: later app updates change only the models you have not touched. Two properties are the
exception and never change on an existing model, whether you edit them or an update does: whether
the model is confidential, and which provider routes it.

## Agents

An agent is what actually answers a chat. Thunderbolt's built-in assistant is the default. You can
point a chat at an external agent instead, over the open [Agent Client
Protocol](https://agentclientprotocol.com), a published standard for connecting a chat client to an
agent that someone else runs.

Three kinds exist:

| Kind                | Where it comes from                                                         |
| ------------------- | --------------------------------------------------------------------------- |
| Built-in            | Thunderbolt's own assistant. Always present unless the operator disables it |
| Deployment-provided | Served by your backend, appears automatically, nothing to configure         |
| Custom              | One you add yourself in **Settings → Agents**                               |

To add one, give it a name and either a WebSocket URL (`wss://…`) or a peer-to-peer connection
ticket, plus an optional description. A ticket is a long code the agent prints when it starts; it
identifies the agent directly, so no URL, hostname or open inbound port is involved.
**Test connection** checks a WebSocket endpoint; a ticket is verified on the first message instead.

An external agent brings its own commands, which appear in the chat `/` menu alongside your skills.

**Reaching an agent on your own machine.** The web app cannot connect to `localhost` or a private
network address: browser rules force that traffic through the cloud proxy (the relay in your
Thunderbolt backend, described under [Preferences](#preferences)), and the relay refuses private
targets. The desktop switch for the proxy does not lift this either, for the reason given under
[Network](#preferences), so use the peer-to-peer ticket instead of a URL.

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

A slug is lowercase letters, digits and hyphens, up to 64 characters, with no hyphen at either end
and none doubled.

The description does the work. The model sees one line per enabled skill and fetches the body only
when it decides the skill applies, so a vague description means the skill is never used and a
precise one costs nothing until it matters.

Skills can be enabled, disabled, and pinned as chips above the composer. Up to ten can be pinned.
A handful of built-in skills define how Thunderbolt renders things like weather and maps in a reply:
those can be switched off but not edited or deleted, and once unpinned cannot be pinned again.

Skills sync across your devices. Edits to a built-in skill are preserved when Thunderbolt updates
its own copies. Worked examples: [Skills](using/skills.md).

## Connections

**Settings → Connections** holds two different things.

**Integrations** are ready-made connections Thunderbolt supplies.

| Integration | What it gives the assistant                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thunderbolt | Web search, fetching a page, and weather. Requires Thunderbolt Pro. Without Pro the row offers Get Pro and the assistant gets none of these tools; with Pro you can switch it off here |
| Google      | Gmail (read, search, draft) and Google Calendar, after you authorize the account                                                                                                       |
| Microsoft   | Outlook mail and OneDrive files, after you authorize the account                                                                                                                       |

Authorizing is per device, and so is switching an integration off.

**MCP servers** are yours to add. [Model Context Protocol](https://modelcontextprotocol.io) is an
open standard for exposing tools to an AI client, so an MCP server is a tool server: it publishes a
list of things the model can do, such as searching a wiki or filing a ticket. Every enabled
server's tools are merged into the model's toolset on each message. Thunderbolt is a client only:
it consumes servers, it does not publish one.

### Adding an MCP server

Give it a name, the server URL, and a credential if it needs one. The name prefixes every tool the
server provides, and the server cannot be saved until a connection test passes. For the credential,
Thunderbolt will:

- use a token or API key you supply, if you supply one;
- otherwise attempt OAuth, offering **Add & Authorize** when the server supports it;
- tell you to supply a token when the server wants OAuth but cannot issue a client automatically.

Servers that need re-authorization later say so on their card.

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

### MCP limitations worth knowing before you plan

- **Servers that run as a local process are not supported.** Entries with a `command` and `args`
  are rejected on import. Run such a server behind the Thunderbolt command-line bridge and connect
  to it peer-to-peer.
- **`https` is required** for any public host. Plain `http` is accepted only for `localhost` and
  private network addresses, which no released build can reach, and nothing warns you at save time.
- **Servers and their credentials are device-local.** Adding a server on one machine does not add it
  anywhere else. They are included in a data export, and restoring that export on another device
  brings them across.
- Deleting a server deletes its stored credential with it.

## Projects

A project is a workspace with durable instructions that every chat inside it inherits, plus a tool
that lets the model search the project's other conversations. Chats stay isolated otherwise: one
never sees another's transcript unless the model goes looking.

Cross-chat search is keyword matching, not meaning-based. A question phrased differently from the
original conversation can miss, so retry with the words you actually used.

There is no project file or document set. See [Projects](using/projects.md).

## Voice

Voice mode uses Thunderbolt's hosted speech engine, which runs transcription and read-aloud inside
the same kind of verified enclave as a confidential model. Nothing needs configuring.

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

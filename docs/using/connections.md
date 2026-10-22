# Connections

You can connect Thunderbolt to other tools and agents. **MCP servers** give the assistant new abilities, like searching a wiki, querying a database or filing a ticket. **External agents**, like Claude Code or Codex, can take over a chat in place of the built-in assistant. Your admin can limit which ones you're allowed to add.

There are also ready-made integrations that let the assistant read your mail, calendar and files. You'll find MCP servers and integrations in **Settings → Connections**, and agents in **Settings → Agents**.

## MCP servers

The Model Context Protocol (MCP) is an open standard for exposing tools to an AI assistant. A server publishes a list of tools, Thunderbolt connects to it, and those tools join the built-in ones in any chat answered by the built-in assistant on a tool-capable model. An external agent brings its own tools instead. Thunderbolt acts only as an MCP client, so it can consume servers but does not publish one of its own.

### Adding a server

**Settings → Connections → New Connection.**

| Field                     | Notes                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **Name**                  | Also becomes the prefix on every tool this server provides, so keep it short and recognizable    |
| **Server URL**            | The server's endpoint, for example `https://mcp.example.com/mcp`                                 |
| **Transport**             | `HTTP` for a modern streamable server, `SSE` only for a legacy server that supports nothing else |
| **Credential (optional)** | A bearer token or API key, if the server uses one                                                |

Once the URL looks complete, Thunderbolt dials the endpoint exactly the way a real chat will and lists the tools it found. **Test connection** re-runs the same check on demand. **Add Server** stays disabled until that test passes, and editing the URL, transport or credential afterwards invalidates the result, so you cannot save a combination that was never tried together. Renaming does not invalidate it.

### What the test tells you

| Result                                | Meaning                                                           | Next step                                      |
| ------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| Tools listed                          | Connected                                                         | Save it                                        |
| Prompt to **Add & Authorize**         | The server wants OAuth and can register Thunderbolt automatically | Click it and sign in to the server             |
| Prompt for a credential               | The server wants OAuth but cannot register a client               | Create a personal access token there, paste it |
| Generic failure with a credential set | The token was rejected                                            | Check the token                                |
| Generic failure                       | Wrong URL, server down, or not reachable from this device         | See [Reachability](#reachability)              |

### Authorizing with OAuth

Servers that support OAuth are handled in the app: Thunderbolt discovers the authorization server, registers itself, opens the sign-in page, and stores the resulting tokens on the device. Tokens refresh on their own shortly before they expire, and if a refresh is rejected the server's detail panel shows **Authorize** again. Only one authorization can be in progress at a time; an abandoned one clears after 10 minutes.

Some servers publish OAuth metadata but do not let a new client register itself. GitHub is the common example. For those, paste a personal access token in the credential field instead.

### Importing several servers at once

Switch the add form to **Advanced (JSON)** and paste an existing `mcpServers` block (a VS Code `servers` block also works), then choose **Import Servers**:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    },
    "staging": {
      "url": "https://staging.example.com/mcp",
      "disabled": true
    }
  }
}
```

- Import is all or nothing. One bad entry fails the whole paste and every problem is listed.
- `"disabled": true` imports the server switched off.
- An `Authorization: Bearer` header becomes the stored credential. Other auth headers are ignored and the server is still imported.
- Entries that launch a local command are rejected. See [Local servers](#local-servers).
- Imported servers are not connection-tested. Open each one afterwards and use **Test connection**.

### Reachability

Desktop and mobile connect to HTTP/SSE MCP servers directly by default. **Settings → Preferences → Network → Use Cloud Proxy** routes them through your deployment's backend when enabled. The browser always uses that backend, which refuses private, internal and loopback addresses. A server on `http://localhost:3000/mcp` is reachable from a native app with Cloud Proxy off, but not through the backend.

The add form checks whether the device could reach the address: plain `http://` is allowed only for loopback and private addresses; public hosts require `https://`. Saving an address does not prove the backend can reach it.

For direct connections in desktop and mobile, enter the server's final address. If requests through Use Cloud Proxy fail because you are signed out, sign in. In desktop and mobile, you can also turn off Use Cloud Proxy. External agents added with a WebSocket address follow this setting too, except addresses on the same device always connect directly.

### Local servers

Servers that run as a local command cannot be added directly. Bridge one with the Thunderbolt command-line tool, which turns it into a peer-to-peer endpoint:

```sh
thunderbolt mcp --transport iroh -- <server-command...>
```

The bridge prints both a node ID and a pairing ticket. Paste either into the **Server URL** field: Thunderbolt recognizes the shape, hides the transport and credential fields, and connects peer-to-peer over an encrypted link instead of over HTTP. A peer-to-peer target has no test step; the connection is verified the first time it is used.

For such a target the form shows an **Authorize this app on your bridge** panel with this app's pairing identity and the command to run on the machine hosting the bridge:

```sh
thunderbolt iroh allow <node-id>
```

Bridges running on a machine signed in to your own account trust your own devices automatically, so that step is usually only needed for someone else's machine or for automated builds.

### How tools appear in chat

Every tool is prefixed with the server name, lowercased, with each run of non-alphanumeric characters turned into a single underscore. A server named `Acme Docs` contributes `acme_docs_search`. The second and later servers that reduce to the same prefix get a numeric suffix; a tool whose full name still collides with an existing one is skipped. The assistant is told which servers are connected and how many tools each contributes, and tool calls in the transcript are labelled with the server they came from.

### Switching off and removing

A disabled server is not connected and its tools are not offered. Deleting a server also deletes its stored credential. If a server is unreachable when you send a message, that server's tools are skipped for that message and Thunderbolt reconnects in the background. The rest of the chat is unaffected.

### Where server settings are stored

MCP servers and their credentials stay on the device that added them. They do **not** sync to your other devices, because a credential is exactly the kind of thing that should not be copied around by a sync service, and a server entry without its credential would not connect anyway. Add the server again on each device, or move it in a backup export, which does include both. Deleting your account erases them along with the rest of the local data. Signing out offers to keep or delete that data, and only the delete choice removes them. Having the device revoked removes them the next time that device connects.

## External agents

An external agent is a separate program that answers a chat instead of the built-in assistant. Thunderbolt talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), an open standard for driving an agent from a chat interface, and remains the interface itself: the same chat window, the same history, the same attachments. The agent does the thinking, and its tools run on its machine, not yours.

Each chat keeps its own agent, picked from the selector at the top of the chat window. The selector is locked while a reply is streaming.

An external agent brings its own model, so the model picker is hidden while one is selected and your entries under **Settings → Models** do not apply to it. It brings its own tools too, so your MCP servers are not offered to it. Your enabled skills are still handed over ([Skills](./skills.md)).

### Where agents come from

The built-in assistant needs no setup and appears under **Your agents**, marked as built into the app. Agents your deployment serves need no setup either and appear under **System agents**. Anything else that speaks ACP and that you can reach is added by you, alongside the built-in one. The two headings only appear when you have both kinds.

### Adding your own

**Settings → Agents → New Agent.** The URL is either a WebSocket endpoint (`wss://example.com/ws`) or a pairing ticket from a bridge; a bare peer identity also works if the peer is discoverable. A WebSocket endpoint must pass **Test connection** before it can be saved. A peer-to-peer target is verified on the first chat instead, because it has to be authorized on the bridge first.

Test connection always connects directly from the device. A passing test proves the endpoint is alive, but a saved agent may connect through your Thunderbolt server. External agents added with a WebSocket address connect directly in desktop and mobile by default. With Use Cloud Proxy on, they need a public `wss://` address. Agents on your local network need a `wss://` address with Use Cloud Proxy off. Plain `ws://` works only for a local bridge at its default port (`8839`) on the same computer as the desktop app. Agents on the same device always connect directly in desktop and mobile, even with the setting on. The web app always uses your Thunderbolt server and cannot reach agents on your device or local network. Use a peer-to-peer bridge instead.

Custom agents sync to your other devices, name, URL and description together.

Deleting a custom agent removes it from Thunderbolt and changes nothing on the remote server.

> An address that only works on one machine, such as a local bridge, appears on your other devices without working there.

### Connecting a local coding agent

The Thunderbolt command-line tool can expose a coding agent that runs on your own machine:

```sh
cd ~/dev/my-project
thunderbolt acp --transport iroh -- thunderbolt acp serve
```

Copy the printed ticket into the agent's URL field. To span several projects, start the bridge from a common parent directory.

A local bridge is also available (`--transport wss`, default port `8839`), printing a URL of the form `ws://127.0.0.1:<port>/?token=...`. It works only in the desktop app on the same computer, at the default port. It connects directly even with Use Cloud Proxy on. The token is regenerated on every start, so a saved URL stops working once the bridge restarts.

### Approving what an agent does

When an agent asks permission to run a tool, the chat shows an inline prompt before anything happens. It names the action, shows the exact command or arguments, and lists any files involved.

The buttons the agent itself offers are usually allow once, allow always, reject once and reject always. Your answer goes straight back to the agent. Two further buttons go beyond them. **Always allow all ... actions** approves this call and every later action of the same kind from this agent, where a kind is reading, editing, deleting, moving, searching, running a command, and so on. **Always allow everything from this agent** approves this call and anything else the agent asks for. A remembered allowance lasts until the app is reloaded or restarted; it is not written to disk and not shared with your other devices.

> **Always allow everything from this agent** is as broad as it sounds. We recommend it only for an agent you run yourself.

Agents can also advertise their own commands. Those appear in the composer's slash menu while the agent is connected and disappear when it disconnects.

### What a deployment controls

Whoever runs the backend decides which agents are available at all.

| Setting                  | Default | Effect                                                                                                                            |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | empty   | Comma-separated list of **system** agent IDs to expose. Empty exposes all of them. Does not affect the built-in agent or your own |
| `ALLOW_CUSTOM_AGENTS`    | `true`  | `false` hides the New Agent action in Settings and in the chat's agent menu                                                       |
| `DISABLE_BUILT_IN_AGENT` | `false` | `true` removes the built-in assistant from the list entirely                                                                      |

If the list cannot be fetched while you are offline, the agents you already had stay in place.

## Account integrations

The Connections screen also lists three ready-made integrations.

| Provider    | What it adds                                                         |
| ----------- | -------------------------------------------------------------------- |
| Thunderbolt | Web search and fetching the contents of a public page. On by default |
| Google      | Gmail inbox check, search and read, draft creation, Google Calendar  |
| Microsoft   | Outlook messages, OneDrive file search and file contents             |

Web search and page fetching need `EXA_API_KEY` on the server. Without it the switch still reads as on and the assistant still reaches for those tools, but the calls fail: a search says "Search service is not configured", while a page fetch returns only a generic server error. Nothing else about the app changes. Google and Microsoft require your deployment to have OAuth credentials configured for that provider (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`). Disconnecting an integration removes the stored authorization. Google mail access stops at drafting: the assistant can create a draft, but cannot send one. Microsoft access is read-only.

## What a connection can and cannot reach

MCP tool calls are not approved one by one. Once a server is connected and enabled, its tools run whenever the model calls them, and your control is at the server level: enable, disable, delete. External agents work the other way round. An ACP agent asks before it edits a file or runs a command, and each request prompts in the chat until you choose one of the always-allow buttons.

Stored credentials never reach the model, and are never part of the conversation. For HTTP/SSE connections, your credential passes through your Thunderbolt server only in the web app or when Use Cloud Proxy is on in desktop and mobile. With Use Cloud Proxy off in desktop and mobile, it goes directly to the tool server.

Desktop and mobile can connect directly to custom model servers and HTTP/SSE MCP servers on your local network with Use Cloud Proxy off. Agents on your local network also need a `wss://` address. With Use Cloud Proxy on, these connections use your Thunderbolt server, which blocks private and internal addresses. External agents then need a public `wss://` address. Custom models on the same device always connect directly, as do external agents on the same device in desktop and mobile. The web app uses your Thunderbolt server, except for custom models on the same device.

The agent the Thunderbolt command-line tool serves is confined to the directory the bridge was launched from and everything below it, ignores any working directory the app sends, has no shell tool, and refuses to fetch loopback or private addresses. A bridged third-party agent enforces its own scope, and whether it can run shell commands is up to that agent.

Only peer identities on a bridge's allowlist can dial it, which means your own account's devices plus anything you allowed manually. To cut a paired machine off, revoke the device in **Settings → Devices**. Live sessions close within about a minute.

Peer-to-peer connections are encrypted end to end between the app and the bridge. The relay that introduces the two sides carries ciphertext and cannot read the traffic. By default these are public relays run by the authors of the underlying networking library; a deployment can point at its own instead with `VITE_IROH_RELAY_URL` when building the app and `THUNDERBOLT_IROH_RELAY_URL` for the command-line tool.

## Troubleshooting

| Symptom                                                     | Likely cause                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Server tests fine on desktop, fails on web                  | It is on a private or loopback address. Bridge it                                           |
| Server card says it needs authorization                     | OAuth was never completed, or a token refresh failed. Use **Authorize**                     |
| Tools vanished mid-conversation                             | The server dropped. Tools are skipped for that message and reconnect follows                |
| A tool name is not what the server documents                | It is prefixed with the connection name, and possibly numbered to avoid a clash             |
| Servers missing on a second device                          | Expected. MCP servers do not sync. Add them again or import a backup                        |
| Bridge URL stopped working after a restart                  | The loopback bridge mints a new token each run. Copy the new URL                            |
| Bridge refuses the app                                      | Run the `thunderbolt iroh allow` command shown in the add form                              |
| Paired bridge stopped connecting after a device was removed | The bridge's own identity was revoked. Remove it in **Settings → Devices**, then pair again |
| No **New Agent** button                                     | Your deployment set `ALLOW_CUSTOM_AGENTS` to `false`                                        |

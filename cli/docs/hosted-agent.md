# Hosting a shared Thunderbolt agent

A team that wants one configured agent instead of N configured clients can run
`acp serve` behind the WebSocket bridge and point everyone's Thunderbolt app at
it. Skills and MCP servers are the agent's, set once by whoever deploys it.

This is the opt-in remote shape. The defaults are unchanged: a bridge with no
extra configuration still binds loopback, still mints a fresh token per run, and
`acp serve` with no agent config is the same agent it always was.

## What the agent gets

`agent.json`, at `THUNDERBOLT_AGENT_CONFIG` or `agent.json` under the state root:

```jsonc
{
  "version": 1,
  "skills": [{ "name": "triage", "description": "Triage an incoming report", "instruction": "…" }],
  "mcpServers": [
    {
      "id": "docs",
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "trustTools": true,
    },
    {
      "id": "tracker",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "authorization": "Bearer …" },
      "trustTools": false,
    },
  ],
}
```

Tools are namespaced `<id>_<tool>`, matching the app's own MCP naming, so two
servers exposing `search` do not collide.

A missing file means no agent-owned skills or servers. A **present but invalid**
file is a startup error rather than a silent downgrade — an operator who wrote a
config meant it to take effect, and an agent quietly missing half its tools looks
healthy while failing the team. One _unreachable_ server at runtime is different:
it is reported on stderr and the rest still load.

### `trustTools` is the decision to make deliberately

`false` — the default, and what you should leave it as unless you have a reason —
means every call to that server's tools raises an ACP permission prompt.

`true` means they run unprompted.

The reason this is per-server rather than a single switch: on a shared agent the
prompt lands on whichever teammate currently has a session open. A blanket
auto-allow lets one person's connection authorise a write on behalf of everyone.
Marking a read-only documentation server trusted is reasonable; marking one that
can write to production is a choice someone should make on purpose.

Trust waives the prompt, not the mode. `read-only` still blocks a trusted tool.

MCP servers can advertise read-only hints, and we deliberately do not honour
them: that is the server describing itself, so trusting it would let a server opt
itself out of the gate.

### Skills

Agent-owned skills win on a name collision with client-sent ones. A hosted agent
exists so its operator decides what it can do; letting a connecting client shadow
a configured skill by reusing the name would hand that decision to whoever
connects. Client skills the agent has no opinion about still come through, so a
personal skill keeps working alongside the team's.

## Exposing it

The app reaches a remote ACP agent over WebSocket, so the bridge has to be
reachable. Three environment variables opt into that, and **all three are
required together**:

| Variable                   | Purpose                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `THUNDERBOLT_BRIDGE_HOST`  | `0.0.0.0` to bind beyond loopback. Unset means loopback, as before.                              |
| `THUNDERBOLT_BRIDGE_TOKEN` | Stable secret, ≥32 chars. Without it the token changes on every restart and every client breaks. |
| `THUNDERBOLT_APP_ORIGIN`   | Your app origin, so the upgrade's `Origin` check passes.                                         |

Once the socket is public, the origin allowlist and the token are the entire
boundary between the internet and a process that spawns agents. Terminate TLS in
front of it, and treat the token as a credential: it is in every client's
configuration, so rotating it means reconfiguring all of them.

```sh
cd /srv/workspace
THUNDERBOLT_BRIDGE_HOST=0.0.0.0 \
THUNDERBOLT_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
THUNDERBOLT_APP_ORIGIN=https://app.example.com \
THUNDERBOLT_AGENT_CONFIG=/srv/agent.json \
thunderbolt acp --transport wss --port 8839 -- thunderbolt acp serve
```

The printed `ws://…/?token=…` URL is what each person adds as a remote ACP agent.

## Two things about a shared agent

**It is a shared identity.** The MCP servers' credentials live on the host, so
everyone connecting acts as one principal against those services. There is no
per-user attribution, and anyone who can reach the bridge can use the team's
tokens. That may be exactly what you want — but it should be a decision.

**One account pays for the inference.** The agent holds one Thunderbolt
credential, so the whole team's usage bills to it and shares its quota. Mint it
from a service account rather than a person's login: it authenticates as its
creator, and offboarding them takes the agent down with them.

## Workspace

The served agent's workspace is the directory the process was launched from, and
any `cwd` a client sends is ignored. Coding tools are the jailed read/write/edit
set — `acp serve` never constructs `bash`, because arbitrary shell cannot be
confined to a workspace. For an agent whose real capability is MCP tools, launch
it somewhere deliberately boring.

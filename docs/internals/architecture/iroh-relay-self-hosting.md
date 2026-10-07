# Self-hosting the iroh relay

The CLI↔app bridge (`thunderbolt acp|mcp --transport iroh`) uses [iroh](https://iroh.computer).
Unless overridden, it uses relay servers operated by n0, iroh's authors.

## What a relay does (and doesn't)

An iroh connection is QUIC between endpoints identified by ed25519 keys (NodeIds). Peers behind NATs
often cannot open a direct UDP path immediately, so every endpoint holds a long-lived connection to
a **home relay**, an HTTPS server that:

| Role                       | What it does                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forwards encrypted packets | When no direct path exists: connection startup, permanent NAT-traversal failure, and the browser client in `crates/thunderbolt-acp-client`, which has no UDP and stays relay-only. |
| Assists hole-punching      | Carries candidate addresses between peers; native peers then try a direct QUIC path and migrate to it when possible.                                                               |
| Names the meeting point    | A ticket embeds the NodeId and home-relay URL, so recipients dial without separate discovery.                                                                                      |

QUIC encrypts traffic end to end for the peer's NodeId, so a relay reads no payloads; it can only
drop or delay packets and observe metadata (participants, timing, volume). Self-hosting buys
availability and metadata control, not confidentiality.

## Why self-host

| Reason           | What it buys                                                        |
| ---------------- | ------------------------------------------------------------------- |
| Availability     | Your own capacity and rate limits, not n0's free best-effort relays |
| Metadata privacy | Connection graphs and traffic timing stay on your infrastructure    |
| Control          | Access tokens, rate limits, logging, metrics                        |

All relay traffic moves to the self-hosted relay, but bare-NodeId dials still query n0's DNS service
(the transport retains `presetN0`). Ticket-based dials, the normal flow, carry their own relay URL
and skip DNS; a custom discovery service removes that last n0 dependency.

## Client configuration

| Client         | Variable                               | Configuration path                                                                         |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLI (Bun)      | `THUNDERBOLT_IROH_RELAY_URL` (runtime) | `cli/src/iroh/endpoint.ts` `configureTransport`, replacing only the relay in the n0 preset |
| Web app (wasm) | `VITE_IROH_RELAY_URL` (build time)     | `src/acp/iroh/iroh-transport.ts` → `crates/thunderbolt-acp-client` relay-only endpoint     |

## Local development

```sh
docker compose -f deploy/iroh-relay/docker-compose.yml up -d
```

The service runs `n0computer/iroh-relay:v1.0.2 --dev` over plain HTTP on port `3340`: no TLS, no
QUIC address discovery, localhost only. Point both clients at it:

```sh
THUNDERBOLT_IROH_RELAY_URL=http://localhost:3340 thunderbolt iroh id
VITE_IROH_RELAY_URL=http://localhost:3340 bun run dev
```

### Verifying your relay

Decode a ticket and confirm its embedded relay URL:

```sh
cd cli
TICKET='<ticket from thunderbolt iroh id>' bun -e \
  'import { EndpointTicket } from "@number0/iroh"; console.log(EndpointTicket.fromString(process.env.TICKET!).endpointAddr().relayUrl())'
```

It must print `http://localhost:3340/` and no n0 relay URL. Then run a round-trip with two state
directories, one identity each:

1. Set `THUNDERBOLT_HOME=/tmp/thunderbolt-a` for identity A and `THUNDERBOLT_HOME=/tmp/thunderbolt-b`
   for identity B, plus `THUNDERBOLT_IROH_RELAY_URL=http://localhost:3340` for both.
2. Run `thunderbolt iroh id` as identity B and copy its NodeId.
3. Run `thunderbolt iroh allow <B_NODE_ID>` as identity A.
4. Start `thunderbolt acp --transport iroh -- cat` as identity A and copy its ticket.
5. Pipe one JSON-RPC line through `thunderbolt acp connect <A_TICKET>` as identity B. Confirm output
   is byte-identical.

Same-host native peers may migrate to a direct path after the handshake; the ticket's relay URL plus a
successful round-trip still verify the configuration.

## Operational notes

- **Version coupling**: align the server minor version with the `iroh` and `@number0/iroh` 1.x
  clients when upgrading either side.
- Default logging omits per-connection details. Set `RUST_LOG=info` or enable metrics when debugging.
- Access modes: `everyone`, `allowlist`, `denylist`, `shared_token`, and an HTTP callback. See
  `deploy/iroh-relay/config.example.toml`.

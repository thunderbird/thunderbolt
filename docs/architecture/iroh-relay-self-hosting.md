# Self-hosting the iroh relay

The CLI↔app bridge (`thunderbolt acp|mcp --transport iroh`) uses
[iroh](https://iroh.computer). Without an override, iroh uses relay servers operated by n0, its
authors. This guide explains the relay's role and how contributors or self-hosters can run one.

## What a relay does (and doesn't)

An iroh connection is QUIC between two endpoints identified by ed25519 keys (NodeIds). Peers behind
NATs often cannot open a direct UDP path immediately, so every endpoint maintains a long-lived
connection to a **home relay**, an HTTPS server that:

1. **Forwards encrypted packets** when no direct path exists. This covers connection startup,
   permanent NAT traversal failures, and the browser client in `crates/thunderbolt-acp-client`,
   which cannot use UDP and therefore remains relay-only.
2. **Assists hole-punching** by carrying candidate addresses between peers. Native peers then try a
   direct QUIC path and migrate to it when possible.
3. **Names the meeting point** because a connection ticket embeds the NodeId and home-relay URL.
   Ticket recipients can dial the peer without separate discovery.

A relay cannot read forwarded traffic. QUIC encrypts traffic end to end for the peer's NodeId. A
hostile relay can drop or delay packets and observe connection metadata, including participants,
timing, and volume, but cannot read payloads. Self-hosting controls availability and metadata
exposure; payload confidentiality does not depend on relay trust.

## Why self-host

- **Availability**: operate capacity and rate limits appropriate for your deployment instead of
  relying on n0's free, best-effort public relays.
- **Metadata privacy**: keep user connection graphs and traffic timing within infrastructure you
  control.
- **Control**: configure access tokens, rate limits, logging, and metrics.

Relay traffic moves fully to the configured self-hosted relay. DNS discovery for bare-NodeId dials
still queries n0's DNS service because the transport retains `presetN0`. Ticket-based dials, the
normal Thunderbolt flow, never use DNS discovery because each ticket contains its relay URL. A
custom discovery service can remove the remaining n0 DNS dependency.

## Client configuration

Both clients accept a relay override. Leaving it unset keeps the n0 default.

| Client         | Variable                               | Configuration path                                                                         |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| CLI (Bun)      | `THUNDERBOLT_IROH_RELAY_URL` (runtime) | `cli/src/iroh/endpoint.ts` `configureTransport`, replacing only the relay in the n0 preset |
| Web app (wasm) | `VITE_IROH_RELAY_URL` (build time)     | `src/acp/iroh/iroh-transport.ts` → `crates/thunderbolt-acp-client` relay-only endpoint     |

## Local development

Start the official relay in development mode:

```sh
docker compose -f deploy/iroh-relay/docker-compose.yml up -d
```

The compose service runs `n0computer/iroh-relay:v1.0.2 --dev` over plain HTTP on port `3340`.
Configure both clients with `http://localhost:3340`:

```sh
THUNDERBOLT_IROH_RELAY_URL=http://localhost:3340 thunderbolt iroh id
VITE_IROH_RELAY_URL=http://localhost:3340 bun run dev
```

Development mode has no TLS or QUIC address discovery. Use it only on localhost.

### Verifying your relay

First, decode a generated endpoint ticket and confirm its embedded relay URL:

```sh
cd cli
TICKET='<ticket from thunderbolt iroh id>' bun -e \
  'import { EndpointTicket } from "@number0/iroh"; console.log(EndpointTicket.fromString(process.env.TICKET!).endpointAddr().relayUrl())'
```

The command must print `http://localhost:3340/` and no n0 relay URL.

Then run a round-trip with two state directories so each process has a distinct identity:

1. Set `THUNDERBOLT_HOME=/tmp/thunderbolt-a` for identity A and
   `THUNDERBOLT_HOME=/tmp/thunderbolt-b` for identity B. Set
   `THUNDERBOLT_IROH_RELAY_URL=http://localhost:3340` for both.
2. Run `thunderbolt iroh id` as identity B and copy its NodeId.
3. Run `thunderbolt iroh allow <B_NODE_ID>` as identity A.
4. Start `thunderbolt acp --transport iroh -- cat` as identity A and copy its ticket.
5. Pipe one JSON-RPC line through
   `thunderbolt acp connect <A_TICKET>` as identity B. Confirm output is byte-identical.

Same-host native peers can migrate to a direct path after the relay-mediated handshake. Embedded
relay URL and successful authenticated round-trip verify relay configuration even when migration
occurs.

## Operational notes

- **Version coupling**: keep the server minor version aligned with the `iroh` and `@number0/iroh`
  1.x clients when upgrading either side.
- Default logging omits per-connection details. Set `RUST_LOG=info` or enable metrics when
  debugging.
- Access modes include `everyone`, `allowlist`, `denylist`, `shared_token`, and an HTTP callback.
  See `deploy/iroh-relay/config.example.toml` for field examples.

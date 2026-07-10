# Self-hosting the iroh relay

The CLI↔app bridge (`thunderbolt acp|mcp --transport iroh`) runs on [iroh](https://iroh.computer),
which by default rides on relay servers operated by n0 (iroh's authors). This doc explains what a
relay actually does, what we self-host versus what still comes from n0, the local PoC, and the
production plan.

## What a relay does (and doesn't)

An iroh connection is QUIC between two endpoints identified by ed25519 keys (NodeIds). Two peers
behind NATs usually can't open a direct UDP path immediately, so every endpoint keeps one
long-lived connection to a **home relay** — an HTTPS server that:

1. **Forwards encrypted packets** between peers when no direct path exists (launch traffic, or
   permanently when hole-punching fails — e.g. the browser, which can't do UDP at all and is
   relay-only by design, see `crates/thunderbolt-acp-client`).
2. **Assists hole-punching**: peers exchange candidate addresses through the relay, then attempt a
   direct QUIC path and migrate to it when it works.
3. **Names the meeting point**: a connection ticket embeds the NodeId + home-relay URL, so a dialer
   knows where to find the peer without any discovery.

What a relay can NOT do: read traffic. Everything it forwards is QUIC end-to-end encrypted to the
peer's NodeId — a hostile relay can drop or delay packets and observe metadata (who talks to whom,
when, how much), but never content. Self-hosting is therefore about **availability and metadata**,
not about payload confidentiality (which we already have).

## Why self-host

- **Availability**: the n0 public relays are a free best-effort service with per-client rate limits;
  they can throttle, change, or disappear. Product traffic needs infrastructure with our SLOs.
- **Metadata privacy**: connection graph + traffic timing of our users stays with us.
- **Control**: access control (token-gate the relay to our clients), rate limits, metrics.

What still comes from n0 after the swap: **DNS discovery** (`presetN0` keeps it). Dialing by *bare
NodeId* resolves the peer's current relay via n0's DNS service; dialing by *ticket* doesn't need it
(the relay URL is in the ticket). Our flows exchange tickets, so n0 DNS is a convenience, not a
dependency — replacing it (iroh supports custom DNS/pkarr discovery) is a possible follow-up,
documented here so nobody thinks the relay swap removed every third party.

## The plumbing already in the code

Both sides accept a relay override; unset keeps today's n0 default:

| Side | Variable | Where it lands |
| --- | --- | --- |
| CLI (Bun) | `THUNDERBOLT_IROH_RELAY_URL` (runtime) | `cli/src/iroh/endpoint.ts` `configureTransport` — swaps ONLY the relay in the n0 preset |
| Web app (wasm) | `VITE_IROH_RELAY_URL` (build-time) | `src/acp/iroh/iroh-transport.ts` → `crates/thunderbolt-acp-client` relay-only endpoint |

## Local PoC (validated)

```sh
cd deploy/iroh-relay && docker compose up -d     # n0computer/iroh-relay:v1.0.2 --dev → plain HTTP :3340
```

Validation run (2026-07-09, iroh 1.x both sides):

1. `THUNDERBOLT_IROH_RELAY_URL=http://localhost:3340 thunderbolt iroh id` → the printed ticket
   decodes to `http://localhost:3340/` as the home relay (no n0 URL present), and `endpoint.online()`
   only resolves once the home relay accepted us — proof the override is fully in effect.
2. Full round-trip through the bridge: identity A ran
   `thunderbolt acp --transport iroh -- cat`, identity B was allowlisted and dialed A's ticket with
   `thunderbolt acp connect <ticket>`; a JSON-RPC line piped into B came back byte-identical through
   A's `cat`. Same-host peers may migrate to a direct path after the relay-mediated handshake —
   which is exactly the intended behavior in production too.

`--dev` mode = plain HTTP, no TLS, no QUIC address discovery. Fine on localhost, never on the
internet.

## Production plan (decision pending)

The relay is a single small Rust binary (the public n0 relays run on modest VMs; CPU cost is
forwarding ciphertext). What it needs from a host:

- A **domain** (e.g. `relay.thunderbolt.io`) — tickets and configs carry this URL.
- **TCP 80 + 443** terminated by the relay itself (`cert_mode = "LetsEncrypt"` auto-provisions);
  port 80 also serves the ACME challenge.
- **UDP 4433** (optional) for QUIC address discovery — the 1.x replacement for STUN. Without it,
  relaying still works; peers just lose one address-discovery mechanism.
- Prometheus metrics on :9090 (internal only).

Two candidate shapes, in order of fit:

1. **Small VPS (Hetzner/Fly/EC2)** — full fit: raw 80/443 + UDP, LetsEncrypt built in, ~$5–10/mo.
   `config.example.toml` in `deploy/iroh-relay/` is this shape.
2. **Render (current infra)** — partial fit: web services proxy HTTP/TLS (the relay's WebSocket
   upgrade works), but no UDP and no self-terminated TLS, so no QUIC address discovery and
   `LetsEncrypt` mode is out (Render terminates TLS; the relay would run `dangerous_http_only`
   behind it — needs a validation spike before committing).

Rollout: stand up the relay → bake the URL as the default in the CLI (still overridable by env) and
`VITE_IROH_RELAY_URL` in app builds → mixed fleets keep working because tickets carry the relay URL
of whoever minted them. Lock down with `access.shared_token` once our clients send it.

## Operational notes

- **Version coupling**: the relay speaks the iroh relay protocol; keep the server minor-version
  aligned with the `iroh`/`@number0/iroh` 1.x clients when bumping either.
- The container logs nothing per-connection at default log level; use `RUST_LOG=info` (or metrics)
  when debugging.
- Access control modes: `everyone` (default), `allowlist`/`denylist` (NodeIds), `shared_token`,
  or an `http` callback — see `config.example.toml`.

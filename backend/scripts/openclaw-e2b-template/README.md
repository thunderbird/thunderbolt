<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at http://mozilla.org/MPL/2.0/. -->

# `thunderbolt-openclaw` E2B template

Every OpenClaw deploy boots a Firecracker microVM from one static, prebuilt E2B
template named `thunderbolt-openclaw` (hardcoded in `backend/src/openclaw/e2b.ts`).
The template is **per E2B account** — anyone running the OpenClaw deploy flow
against their own `E2B_API_KEY` has to build it once in their account first.

```
build.ts               # builds + publishes the template (E2B SDK Template builder)
acp-ws-shim.ts         # WS↔stdio adapter, baked at /opt/shim/acp-ws-shim.ts
docker-entrypoint.sh   # baked at /opt/docker-entrypoint.sh (see "Drift" below)
Dockerfile             # plain-Docker equivalent of the same stack; fallback / local runs
```

## Build it

```bash
# backend/.env → E2B_API_KEY=<your key>
bun backend/scripts/openclaw-e2b-template/build.ts
```

Overrides: `TEMPLATE_NAME` (default `thunderbolt-openclaw`), `BASE_TEMPLATE`
(default `u2bzpic9lzyttv5jh36g`).

The build starts from the bare-OpenClaw template — which already has node and the
`openclaw` CLI — and layers bun, the shim, and the entrypoint. There is
deliberately **no `setStartCmd`**: E2B validates a start command's readiness at
build time, but the launch needs per-deployment inference env (base URL + token)
that only exists at runtime, so `e2b.ts` runs its own launch script at deploy time
via `commands.run` and probes ACP readiness (port 8790) itself.

## Gotchas

- **`BASE_TEMPLATE` must be visible to your API key.** If that bare-OpenClaw
  template isn't in your account, the build fails immediately. Fallback: build the
  stack from scratch with the `Dockerfile` here (`e2b template build`, or
  `.fromDockerfile()` in `build.ts`) — note it installs `openclaw` via `npm -g`
  (`/usr/local/bin`) while the base template installs to `~/.openclaw/bin`. Both
  land on PATH, so either works, but the images are not identical.
- **Drift: the baked `docker-entrypoint.sh` is no longer executed.** It hard-wires
  OpenRouter (`--auth-choice openrouter-api-key`), while `e2b.ts` now onboards a
  *custom* provider from `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `PROVIDER_ID` /
  `COMPATIBILITY`. It's still copied in so rebuilt templates match the ones already
  deployed; what the template genuinely must provide is `bun`,
  `/opt/shim/acp-ws-shim.ts`, and the `openclaw` CLI.

The original local-Docker POC writeup (pre-E2B bridge spike, THU-738) lives on the
`raivieiraadriano92/openclaw-acp-poc-spike` branch under `spikes/openclaw-acp-poc/`.

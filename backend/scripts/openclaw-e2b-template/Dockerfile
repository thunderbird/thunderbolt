# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Headless OpenClaw ACP agent for the Thunderbolt "deploy an agent" spike.
# Runs the whole stack in one container: OpenClaw Gateway + `openclaw acp` +
# the WS↔stdio shim. Reachable over ws://<host>:8790 — the same URL Thunderbolt's
# "add custom agent" flow already accepts. This is the artifact that later runs
# in an E2B microVM per user; here we prove it in plain Docker first.

FROM node:22-slim

# git: coding-agent worktrees. curl/ca-certificates: bun install + TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun (runs the shim) installed to a shared prefix so the non-root user can use it.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

# OpenClaw, pinned (release cadence is ~2 days with breaking changes — never :latest).
ARG OPENCLAW_VERSION=2026.7.1-2
RUN npm install -g openclaw@${OPENCLAW_VERSION}

COPY acp-ws-shim.ts /opt/shim/acp-ws-shim.ts
COPY docker-entrypoint.sh /opt/docker-entrypoint.sh
RUN chmod +x /opt/docker-entrypoint.sh && chown -R node:node /home/node

# Non-root: agent-run code executes here. Real isolation is the microVM boundary
# (E2B) later; the container user is defense-in-depth, not the trust boundary.
USER node
WORKDIR /home/node
ENV HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=8790

EXPOSE 8790
ENTRYPOINT ["/opt/docker-entrypoint.sh"]

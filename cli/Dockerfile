# Hosted Thunderbolt ACP agent — see docs/hosted-agent.md.
#
# Runs the WebSocket bridge, which spawns one `acp serve` per connection. Build
# from the repo root so `shared/` is in context:
#
#   docker build -f cli/Dockerfile -t thunderbolt-agent .
FROM oven/bun:1.3-slim

ENV NODE_ENV=production \
    # Loopback is the library default; a container needs the port reachable.
    # The origin allowlist and THUNDERBOLT_BRIDGE_TOKEN remain the boundary.
    THUNDERBOLT_BRIDGE_HOST=0.0.0.0 \
    # State root: provider config, account auth, ACP session logs. Mount a
    # volume here to keep sessions across restarts; otherwise resume finds
    # nothing after a deploy.
    THUNDERBOLT_HOME=/state \
    THUNDERBOLT_AGENT_CONFIG=/state/agent.json

WORKDIR /app

# Dependency layer first so source edits don't reinstall.
COPY cli/package.json cli/bun.lock ./cli/
RUN cd cli && bun install --frozen-lockfile

COPY shared/ ./shared/
COPY cli/ ./cli/

# The agent's workspace is its launch directory, and any `cwd` a client sends is
# ignored. Deliberately empty: this agent's capability is MCP tools and skills,
# not the filesystem, and the jailed read/write/edit tools should have nothing
# interesting to reach.
RUN mkdir -p /workspace /state && \
    useradd --create-home --uid 10001 agent && \
    chown -R agent:agent /workspace /state
USER agent
WORKDIR /workspace

EXPOSE 8839

# `--port` takes the platform's assigned port when there is one. Everything
# after `--` is the stdio command the bridge spawns per connection.
CMD ["sh", "-c", "bun run /app/cli/src/index.ts acp --transport wss --port ${PORT:-8839} -- bun run /app/cli/src/index.ts acp serve"]

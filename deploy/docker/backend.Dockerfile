# Single stage: Bun runtime with source
FROM oven/bun:1.4.4

# The base image can lag Debian's security fixes; take them at build time (nightly-images.yml rebuilds daily).
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

# Install runtime deps only. Dev tooling (e.g. the react-email preview server) carries CVEs we never execute,
# and --production alone still installs devDependencies that a runtime package lists as an optional peer.
# The install cache holds a second copy of every package, the pruned ones included.
COPY --chown=1000:1000 backend/package.json backend/bun.lock ./
COPY scripts/prune-unreachable-deps.ts /tmp/
RUN bun install --frozen-lockfile --production \
  && bun /tmp/prune-unreachable-deps.ts \
  && rm -rf /tmp/prune-unreachable-deps.ts /root/.bun/install/cache \
  && chown 1000:1000 /app/backend

# Copy source
COPY --chown=1000:1000 backend/src ./src
COPY --chown=1000:1000 backend/tsconfig.json ./
COPY --chown=1000:1000 backend/drizzle ./drizzle
COPY --chown=1000:1000 shared /app/shared

# Entrypoint: wait for Postgres, then start the server, which applies pending migrations
COPY --chmod=755 --chown=1000:1000 deploy/docker/backend-entrypoint.sh ./entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

USER 1000

ENTRYPOINT ["./entrypoint.sh"]

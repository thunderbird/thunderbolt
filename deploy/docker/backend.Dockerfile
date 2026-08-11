# Single stage: Bun runtime with source
FROM oven/bun:latest

WORKDIR /app/backend

# Install deps
COPY --chown=1000:1000 backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile && chown 1000:1000 /app/backend

# Copy source
COPY --chown=1000:1000 backend/src ./src
COPY --chown=1000:1000 backend/tsconfig.json ./
COPY --chown=1000:1000 backend/drizzle ./drizzle
COPY --chown=1000:1000 backend/drizzle.config.ts ./
COPY --chown=1000:1000 shared /app/shared

# Entrypoint: run migrations then start server
COPY --chmod=755 --chown=1000:1000 deploy/docker/backend-entrypoint.sh ./entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

USER 1000

ENTRYPOINT ["./entrypoint.sh"]

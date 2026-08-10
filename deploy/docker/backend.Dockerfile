# Single stage: Bun runtime with source
FROM oven/bun:latest

WORKDIR /app/backend

# Install deps
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY backend/src ./src
COPY backend/tsconfig.json ./
COPY backend/drizzle ./drizzle
COPY backend/drizzle.config.ts ./
COPY shared /app/shared

# Entrypoint: run migrations then start server
COPY --chmod=755 deploy/docker/backend-entrypoint.sh ./entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# The base image already runs as user 1000 (bun); keep this explicit for clarity and scanners.
USER 1000

ENTRYPOINT ["./entrypoint.sh"]

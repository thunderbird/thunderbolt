# Cloud runner: Bun runtime with source (same pattern as backend.Dockerfile).
# The runner imports harness modules from cli/src, so both packages' production
# dependencies are installed side by side (module resolution walks up from the
# importing file's directory). /app/shared has no node_modules above it, so
# modules under shared/ must stay free of runtime dependencies — they take their
# libraries as arguments from whichever package imports them.
FROM oven/bun:latest

WORKDIR /app/cloud-runner

# Install deps (layer-cached until a lockfile changes)
COPY cli/package.json cli/bun.lock /app/cli/
RUN cd /app/cli && bun install --frozen-lockfile --production
COPY cloud-runner/package.json cloud-runner/bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY shared /app/shared
COPY cli/src /app/cli/src
COPY cloud-runner/src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV CLOUD_RUNNER_DATA_DIR=/data

# Drop root before runtime: the runner executes agent tool calls over untrusted
# input, so the process runs as the base image's non-root `bun` user (uid 1000,
# matching the EFS access point's posixUser in deploy/cloud-runner). The chown
# covers running without a mount; in production the EFS mount shadows /data.
RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]

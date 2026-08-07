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

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]

# Stage 1: Build the Astro site (marketing + blog + docs)
#
# The docs content is loaded from the repo's root-level `docs/` directory via
# `web/src/loaders/repo-docs-loader.ts` — needs to be available at build time.
FROM oven/bun:latest AS build

WORKDIR /app

# Install deps first for layer caching
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile

# Copy Astro sources + the root `docs/` the loader reads from
COPY web ./web
COPY docs ./docs

WORKDIR /app/web
RUN bun run build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY deploy/config/marketing-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

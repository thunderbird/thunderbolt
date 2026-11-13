# Stage 1: Build the Astro site (marketing + blog + docs)
#
# The docs content is loaded from the repo's root-level `docs/` directory via
# `web/src/loaders/repo-docs-loader.ts` — needs to be available at build time.
#
# --platform=$BUILDPLATFORM: the build output is platform-independent static
# assets (Astro also invokes `sharp` here for image optimization, whose
# native binary only needs to match the build host, not the target image), so
# this stage runs natively instead of under QEMU emulation for the target
# platform. Only the final nginx stage below is built per target platform.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build

WORKDIR /app

# Install deps first for layer caching
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile

# Copy Astro sources + the root `docs/` the loader reads from
COPY web ./web
COPY docs ./docs

WORKDIR /app/web
ARG PUBLIC_CONTACT_ENDPOINT=
RUN PUBLIC_CONTACT_ENDPOINT="$PUBLIC_CONTACT_ENDPOINT" bun run build

# Stage 2: Serve with nginx
FROM nginxinc/nginx-unprivileged:alpine

# The base image can lag Alpine's security fixes; take them at build time (nightly-images.yml rebuilds daily).
USER root
RUN apk upgrade --no-cache

# The nginx entrypoint reads /etc/resolv.conf before rendering templates, covering
# Docker's embedded DNS, Kubernetes cluster DNS, and other container runtimes.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

COPY deploy/config/marketing-nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html

# Keep the final-stage user explicit for Semgrep's container check.
USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]

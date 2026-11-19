FROM postgres:18-alpine

# The base image can lag Alpine's security fixes; take them at build time (nightly-images.yml rebuilds daily).
RUN apk upgrade --no-cache

COPY --chmod=755 deploy/docker/postgres-init/01-powersync.sh /docker-entrypoint-initdb.d/

EXPOSE 5432

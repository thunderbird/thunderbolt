FROM postgres:18-alpine

COPY --chmod=755 deploy/docker/postgres-init/01-powersync.sh /docker-entrypoint-initdb.d/

EXPOSE 5432

FROM postgres:18-alpine

COPY deploy/docker/postgres-init/01-powersync.sql /docker-entrypoint-initdb.d/

EXPOSE 5432

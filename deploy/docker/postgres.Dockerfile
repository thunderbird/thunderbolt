FROM postgres:18-alpine

# The base image can lag Alpine's security fixes; take them at build time (nightly-images.yml rebuilds daily).
# Retry transient mirror failures, but still fail if security updates cannot be installed.
RUN for attempt in 1 2 3; do \
      apk upgrade --no-cache && break; \
      if [ "$attempt" -eq 3 ]; then exit 1; fi; \
      sleep 5; \
    done

COPY --chmod=755 deploy/docker/postgres-init/01-powersync.sh /docker-entrypoint-initdb.d/

EXPOSE 5432

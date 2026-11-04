# Pinned: Sync Streams need 1.20+, and 1.26+ fixes GHSA-hfrf-pvrg-5c3h. Bump together with
# both compose files, deploy/k8s/values.yaml and its test, and deploy/docker/README.md.
FROM journeyapps/powersync-service:1.27.0

COPY deploy/config/powersync-config.yaml /config/config.yaml

ENV POWERSYNC_CONFIG_PATH=/config/config.yaml
# Read by the config's `version_label`; the service refuses to start if it is unset.
ENV PS_SYNC_CONFIG_VERSION=1

# The base image already runs as user 901; keep this explicit for clarity and scanners.
USER 901

EXPOSE 8080

CMD ["start", "-r", "unified"]

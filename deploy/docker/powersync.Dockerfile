# Pinned: Sync Streams need 1.20+, and 1.26+ fixes GHSA-hfrf-pvrg-5c3h. Bump together with
# both compose files, deploy/k8s/values.yaml and its test, and deploy/docker/README.md.
FROM journeyapps/powersync-service:1.27.0

COPY deploy/config/powersync-config.yaml /config/config.yaml

ENV POWERSYNC_CONFIG_PATH=/config/config.yaml

# The base image already runs as user 901; keep this explicit for clarity and scanners.
USER 901

EXPOSE 8080

CMD ["start", "-r", "unified"]

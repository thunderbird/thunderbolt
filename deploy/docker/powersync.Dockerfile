FROM journeyapps/powersync-service:latest

COPY deploy/config/powersync-config.yaml /config/config.yaml

ENV POWERSYNC_CONFIG_PATH=/config/config.yaml

# The base image already runs as user 901; keep this explicit for clarity and scanners.
USER 901

EXPOSE 8080

CMD ["start", "-r", "unified"]

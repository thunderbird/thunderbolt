FROM journeyapps/powersync-service:latest

COPY deploy/enterprise/config/powersync-config.yaml /config/config.yaml

ENV POWERSYNC_CONFIG_PATH=/config/config.yaml

EXPOSE 8080

CMD ["start", "-r", "unified"]

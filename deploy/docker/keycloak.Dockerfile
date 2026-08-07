FROM quay.io/keycloak/keycloak:26.7

COPY deploy/config/keycloak-realm.json /opt/keycloak/data/import/thunderbolt-realm.json

# The base image already runs as user 1000; keep this explicit for clarity and scanners.
USER 1000

EXPOSE 8080

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm"]

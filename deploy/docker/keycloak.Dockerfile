FROM quay.io/keycloak/keycloak:26.0

COPY deploy/config/keycloak-realm.json /opt/keycloak/data/import/thunderbolt-realm.json

EXPOSE 8080

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm"]

FROM quay.io/keycloak/keycloak:26.8

COPY deploy/config/keycloak-realm.json /opt/keycloak/data/import/thunderbolt-realm.json

# JDK_JAVA_OPTIONS reaches the server and kcadm.sh/kcreg.sh. Remove once the base image ships
# Java 21.0.13.1 or later.
ENV JDK_JAVA_OPTIONS="-XX:-UseBASE64Intrinsics"

# The base image already runs as user 1000; keep this explicit for clarity and scanners.
USER 1000

EXPOSE 8080

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm"]

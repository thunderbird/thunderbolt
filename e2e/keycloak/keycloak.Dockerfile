# Keycloak with the outbound SCIM extension, for the local multi-realm validation stack only.
# Never ship this image: the extension is third-party, GPL-3.0 and unsupported by Thunderbolt.
# The build args come from extension.lock (see docker-compose.yml).
ARG KEYCLOAK_IMAGE
ARG MAVEN_IMAGE

FROM ${MAVEN_IMAGE} AS build
ARG EXTENSION_REPO
ARG EXTENSION_COMMIT
WORKDIR /src
# Fetch exactly the pinned commit. Git's content-addressed hash is the integrity check:
# GitHub's archive tarballs are not guaranteed to stay byte-identical.
RUN git init -q \
 && git remote add origin "${EXTENSION_REPO}" \
 && git fetch -q --depth 1 origin "${EXTENSION_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${EXTENSION_COMMIT}"
RUN mvn -B -q -DskipTests package \
 && cp target/keycloak-scim-outbound-*.jar /keycloak-scim-outbound.jar

FROM ${KEYCLOAK_IMAGE}
COPY --from=build /keycloak-scim-outbound.jar /opt/keycloak/providers/
COPY e2e/keycloak/realms/ /opt/keycloak/data/import/
# The base image already runs as user 1000; keep this explicit for clarity and scanners.
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]

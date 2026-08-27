# Prod-capable Keycloak image. The default command is `start-dev`, which runs on
# the file-backed H2 database — fine for local and other ephemeral use. A
# deployment that needs state to survive a redeploy opts into production mode by
# overriding the command with `start --optimized` and pointing KC_DB_URL /
# KC_DB_USERNAME / KC_DB_PASSWORD at Postgres (see the Railway deployment).
#
# `start-dev` implies H2, which Keycloak documents as development-only: on an
# orchestrator without a persistent volume the realm is ephemeral — every redeploy
# re-imports the realm JSON and discards everything created since (admin-console
# users, master-realm settings such as brute-force protection, and login/admin
# event history), and it leaves `KC_BOOTSTRAP_ADMIN_*` load-bearing on every boot
# when it is meant for the first boot only.
#
# Two stages so `start --optimized` is available to deployments that opt in:
# build-time options (notably the database vendor) are baked in by `kc.sh build`,
# and startup then skips re-deriving them. Runtime options — hostname, DB URL,
# credentials — still come from the environment.
FROM quay.io/keycloak/keycloak:26.7 AS builder

# Build-time option: selects the JDBC driver and dialect compiled into the image.
# KC_DB_URL / KC_DB_USERNAME / KC_DB_PASSWORD remain runtime options.
ENV KC_DB=postgres

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7

COPY --from=builder /opt/keycloak/ /opt/keycloak/

# `--import-realm` runs on every boot but imports only realms that do not yet
# exist; once the thunderbolt realm is present the import is skipped. For a
# deployment on Postgres that is the point: changes made in the admin console
# survive a redeploy. The flip side is that later edits to this realm JSON no
# longer take effect once the database already holds the realm — make those
# changes in the admin console.
COPY deploy/config/keycloak-realm.json /opt/keycloak/data/import/thunderbolt-realm.json

# The base image already runs as user 1000; keep this explicit for clarity and scanners.
USER 1000

EXPOSE 8080

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm"]

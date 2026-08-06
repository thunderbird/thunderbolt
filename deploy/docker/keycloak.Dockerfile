# Keycloak in production mode (`start`), not `start-dev`.
#
# `start-dev` implies the file-backed H2 database, which Keycloak documents as
# development-only. On an orchestrator without a persistent volume that makes the
# whole realm ephemeral: every redeploy re-imports the realm JSON and discards
# everything created since — users added in the admin console, master-realm
# settings such as brute-force protection, and the login/admin event history. It
# also leaves `KC_BOOTSTRAP_ADMIN_*` load-bearing on every boot, when it is meant
# for the first boot only.
#
# Two stages so the image can run `start --optimized`: build-time options (notably
# the database vendor) are baked in by `kc.sh build`, and startup then skips
# re-deriving them. Runtime options — hostname, DB URL, credentials — still come
# from the environment.
FROM quay.io/keycloak/keycloak:26.7 AS builder

# Build-time option: selects the JDBC driver and dialect compiled into the image.
# KC_DB_URL / KC_DB_USERNAME / KC_DB_PASSWORD remain runtime options.
ENV KC_DB=postgres

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7

COPY --from=builder /opt/keycloak/ /opt/keycloak/

# `--import-realm` reads this on the first boot against an EMPTY database. Once
# the realm exists the import is skipped, which is the whole point of moving off
# H2: changes made in the admin console now survive a redeploy. The flip side is
# that edits to this file (or to KC_SEED_*) no longer take effect on a database
# that already holds the realm — change those in the console, or drop the schema.
COPY deploy/config/keycloak-realm.json /opt/keycloak/data/import/thunderbolt-realm.json

EXPOSE 8080

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm"]

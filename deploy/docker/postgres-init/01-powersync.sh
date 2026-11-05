#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# PowerSync replication role + publication. Runs on first Postgres init only.
# Templated as a shell script (rather than plain SQL) so the role password can
# come from an env var — preview environments randomize POWERSYNC_DB_PASSWORD
# per stack via Pulumi; local + enterprise stacks fall back to the default.
# See https://docs.powersync.com/configuration/source-db/setup
#
# /bin/sh (not bash) — postgres:17-alpine doesn't ship bash.
set -eu

: "${POWERSYNC_DB_PASSWORD:?POWERSYNC_DB_PASSWORD must be set on the postgres container}"

# Dev default so a fresh local stack initializes without extra config; a
# deployment that runs Keycloak on Postgres overrides this and sets the same
# value as KC_DB_PASSWORD.
: "${KEYCLOAK_DB_PASSWORD:=keycloak}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set powersync_pass="$POWERSYNC_DB_PASSWORD" \
  --set keycloak_pass="$KEYCLOAK_DB_PASSWORD" <<-'EOSQL'
  CREATE SCHEMA IF NOT EXISTS "powersync";

  -- :'powersync_pass' is psql's safe-quoting form for variable substitution.
  CREATE ROLE powersync_role WITH REPLICATION BYPASSRLS LOGIN PASSWORD :'powersync_pass';

  -- Required in PostgreSQL 15+ where powersync schema privileges are revoked by default
  GRANT USAGE ON SCHEMA powersync TO powersync_role;

  GRANT SELECT ON ALL TABLES IN SCHEMA powersync TO powersync_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA powersync GRANT SELECT ON TABLES TO powersync_role;
  CREATE PUBLICATION powersync FOR ALL TABLES;

  -- Separate database for PowerSync bucket storage (avoids schema conflicts with app data).
  -- See https://docs.powersync.com/configuration/powersync-service/self-hosted-instances
  CREATE DATABASE powersync_storage OWNER postgres;

  -- Dedicated role + database for the bundled Keycloak IdP, for deployments that
  -- opt into production mode (`start --optimized` on Postgres rather than the
  -- default `start-dev` on H2). A dedicated role so the IdP connects with least
  -- privilege rather than the Postgres superuser; its own database because
  -- Keycloak owns ~95 tables managed by Liquibase, which has no business sharing
  -- a namespace with the app's Drizzle migrations. Harmless when unused -- an
  -- empty database costs nothing. Opt-in prod deployments set KC_DB_USERNAME to
  -- this role and KC_DB_PASSWORD to the value above.
  CREATE ROLE keycloak_role WITH LOGIN PASSWORD :'keycloak_pass';
  CREATE DATABASE keycloak OWNER keycloak_role;
EOSQL

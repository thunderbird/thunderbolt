-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE SCHEMA IF NOT EXISTS "powersync";

-- PowerSync replication role and publication (runs on first Postgres init only).
-- See https://docs.powersync.com/configuration/source-db/setup
CREATE ROLE powersync_role WITH REPLICATION BYPASSRLS LOGIN PASSWORD 'myhighlyrandompassword';

-- Grant USAGE on schema (required in PostgreSQL 15+ where powersync schema privileges are revoked by default)
GRANT USAGE ON SCHEMA powersync TO powersync_role;

GRANT SELECT ON ALL TABLES IN SCHEMA powersync TO powersync_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA powersync GRANT SELECT ON TABLES TO powersync_role;
CREATE PUBLICATION powersync FOR ALL TABLES;

-- Separate database for PowerSync bucket storage (avoids schema conflicts with app data).
-- See https://docs.powersync.com/configuration/powersync-service/self-hosted-instances
CREATE DATABASE powersync_storage OWNER postgres;

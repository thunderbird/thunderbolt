-- PowerSync replication role and publication (runs on first Postgres init only).
-- See https://docs.powersync.com/configuration/source-db/setup
CREATE ROLE powersync_role WITH REPLICATION BYPASSRLS LOGIN PASSWORD 'myhighlyrandompassword';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO powersync_role;
CREATE PUBLICATION powersync FOR ALL TABLES;

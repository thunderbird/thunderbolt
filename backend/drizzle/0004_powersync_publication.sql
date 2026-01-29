-- PowerSync requires a Postgres publication for logical replication.
-- See https://docs.powersync.com/configuration/source-db/setup
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'powersync') THEN
    CREATE PUBLICATION powersync FOR ALL TABLES;
  END IF;
END
$$;

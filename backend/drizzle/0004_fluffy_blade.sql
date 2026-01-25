-- Custom SQL migration file, put your code below! ---- PowerSync publication for WAL replication
-- This allows PowerSync Cloud to detect changes in these tables

DROP PUBLICATION IF EXISTS powersync;

CREATE PUBLICATION powersync FOR ALL TABLES;


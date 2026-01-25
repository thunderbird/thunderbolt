-- Custom SQL migration file, put your code below! ---- PowerSync publication for WAL replication
-- This allows PowerSync Cloud to detect changes in these tables

CREATE PUBLICATION powersync FOR TABLE
  chat_messages,
  chat_threads,
  mcp_servers,
  models,
  prompts,
  settings,
  tasks,
  triggers;


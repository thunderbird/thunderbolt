-- PowerSync publication for WAL replication
-- This allows PowerSync Cloud to detect changes in these tables

CREATE PUBLICATION powersync FOR TABLE
  settings,
  chat_threads,
  chat_messages,
  tasks,
  models,
  mcp_servers,
  prompts,
  triggers;

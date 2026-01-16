-- Custom SQL migration file, put your code below! ---- Drop manually created indexes so Drizzle can manage them from schema
DROP INDEX IF EXISTS `idx_chat_messages_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_chat_threads_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_tasks_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_models_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_prompts_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_triggers_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_servers_active`;
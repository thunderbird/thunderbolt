ALTER TABLE `chat_messages` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `triggers` ADD `deleted_at` integer;
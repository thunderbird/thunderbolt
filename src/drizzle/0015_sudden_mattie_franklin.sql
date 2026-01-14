PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text,
	`role` text,
	`parts` text,
	`chat_thread_id` text,
	`model_id` text,
	`parent_id` text,
	`cache` text,
	`metadata` text,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "content", "role", "parts", "chat_thread_id", "model_id", "parent_id", "cache", "metadata", "deleted_at") SELECT "id", "content", "role", "parts", "chat_thread_id", "model_id", "parent_id", "cache", "metadata", "deleted_at" FROM `chat_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`is_encrypted` integer DEFAULT 0,
	`triggered_by` text,
	`was_triggered_by_automation` integer DEFAULT 0,
	`context_size` integer,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_chat_threads`("id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size", "deleted_at") SELECT "id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size", "deleted_at" FROM `chat_threads`;--> statement-breakpoint
DROP TABLE `chat_threads`;--> statement-breakpoint
ALTER TABLE `__new_chat_threads` RENAME TO `chat_threads`;--> statement-breakpoint
CREATE TABLE `__new_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`prompt` text,
	`model_id` text,
	`deleted_at` integer,
	`default_hash` text
);
--> statement-breakpoint
INSERT INTO `__new_prompts`("id", "title", "prompt", "model_id", "deleted_at", "default_hash") SELECT "id", "title", "prompt", "model_id", "deleted_at", "default_hash" FROM `prompts`;--> statement-breakpoint
DROP TABLE `prompts`;--> statement-breakpoint
ALTER TABLE `__new_prompts` RENAME TO `prompts`;--> statement-breakpoint
CREATE TABLE `__new_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_type` text,
	`trigger_time` text,
	`prompt_id` text,
	`is_enabled` integer DEFAULT 1,
	`deleted_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_triggers`("id", "trigger_type", "trigger_time", "prompt_id", "is_enabled", "deleted_at") SELECT "id", "trigger_type", "trigger_time", "prompt_id", "is_enabled", "deleted_at" FROM `triggers`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
DROP INDEX `mcp_servers_id_unique`;--> statement-breakpoint
DROP INDEX `models_id_unique`;--> statement-breakpoint
DROP INDEX `tasks_id_unique`;
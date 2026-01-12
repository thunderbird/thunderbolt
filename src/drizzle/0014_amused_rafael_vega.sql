-- Add deleted_at columns to remaining tables
ALTER TABLE `chat_messages` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `triggers` ADD `deleted_at` integer;--> statement-breakpoint

PRAGMA foreign_keys=OFF;--> statement-breakpoint

-- Recreate chat_threads table with nullable columns
CREATE TABLE `__new_chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`is_encrypted` integer DEFAULT 0,
	`triggered_by` text,
	`was_triggered_by_automation` integer DEFAULT 0,
	`context_size` integer,
	`deleted_at` integer,
	FOREIGN KEY (`triggered_by`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_chat_threads`("id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size", "deleted_at") SELECT "id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size", "deleted_at" FROM `chat_threads`;--> statement-breakpoint
DROP TABLE `chat_threads`;--> statement-breakpoint
ALTER TABLE `__new_chat_threads` RENAME TO `chat_threads`;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);--> statement-breakpoint

-- Recreate chat_messages table with nullable columns
CREATE TABLE `__new_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text,
	`role` text,
	`parts` text,
	`chat_thread_id` text NOT NULL,
	`model_id` text,
	`parent_id` text,
	`cache` text,
	`metadata` text,
	`deleted_at` integer,
	FOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "content", "role", "parts", "chat_thread_id", "model_id", "parent_id", "cache", "metadata", "deleted_at") SELECT "id", "content", "role", "parts", "chat_thread_id", "model_id", "parent_id", "cache", "metadata", "deleted_at" FROM `chat_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint

-- Recreate tasks table with nullable columns
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`item` text,
	`order` integer DEFAULT 0,
	`is_complete` integer DEFAULT 0,
	`default_hash` text,
	`deleted_at` integer
);--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "item", "order", "is_complete", "default_hash", "deleted_at") SELECT "id", "item", "order", "is_complete", "default_hash", "deleted_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);--> statement-breakpoint

-- Recreate models table with nullable columns
CREATE TABLE `__new_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text,
	`name` text,
	`model` text,
	`url` text,
	`api_key` text,
	`is_system` integer DEFAULT 0,
	`enabled` integer DEFAULT 1,
	`tool_usage` integer DEFAULT 1,
	`is_confidential` integer DEFAULT 0,
	`start_with_reasoning` integer DEFAULT 0,
	`supports_parallel_tool_calls` integer DEFAULT 1,
	`context_window` integer,
	`deleted_at` integer,
	`default_hash` text,
	`vendor` text,
	`description` text
);--> statement-breakpoint
INSERT INTO `__new_models`("id", "provider", "name", "model", "url", "api_key", "is_system", "enabled", "tool_usage", "is_confidential", "start_with_reasoning", "supports_parallel_tool_calls", "context_window", "deleted_at", "default_hash", "vendor", "description") SELECT "id", "provider", "name", "model", "url", "api_key", "is_system", "enabled", "tool_usage", "is_confidential", "start_with_reasoning", "supports_parallel_tool_calls", "context_window", "deleted_at", "default_hash", "vendor", "description" FROM `models`;--> statement-breakpoint
DROP TABLE `models`;--> statement-breakpoint
ALTER TABLE `__new_models` RENAME TO `models`;--> statement-breakpoint
CREATE UNIQUE INDEX `models_id_unique` ON `models` (`id`);--> statement-breakpoint

-- Recreate mcp_servers table with nullable columns
CREATE TABLE `__new_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`type` text DEFAULT 'http',
	`url` text,
	`command` text,
	`args` text,
	`enabled` integer DEFAULT 1,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch()),
	`deleted_at` integer
);--> statement-breakpoint
INSERT INTO `__new_mcp_servers`("id", "name", "type", "url", "command", "args", "enabled", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "type", "url", "command", "args", "enabled", "created_at", "updated_at", "deleted_at" FROM `mcp_servers`;--> statement-breakpoint
DROP TABLE `mcp_servers`;--> statement-breakpoint
ALTER TABLE `__new_mcp_servers` RENAME TO `mcp_servers`;--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_id_unique` ON `mcp_servers` (`id`);--> statement-breakpoint

-- Recreate prompts table with nullable columns
CREATE TABLE `__new_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`prompt` text,
	`model_id` text NOT NULL,
	`deleted_at` integer,
	`default_hash` text,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_prompts`("id", "title", "prompt", "model_id", "deleted_at", "default_hash") SELECT "id", "title", "prompt", "model_id", "deleted_at", "default_hash" FROM `prompts`;--> statement-breakpoint
DROP TABLE `prompts`;--> statement-breakpoint
ALTER TABLE `__new_prompts` RENAME TO `prompts`;--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_id_unique` ON `prompts` (`id`);--> statement-breakpoint

-- Recreate triggers table with nullable columns
CREATE TABLE `__new_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_type` text,
	`trigger_time` text,
	`prompt_id` text NOT NULL,
	`is_enabled` integer DEFAULT 1,
	`deleted_at` integer,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE cascade ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_triggers`("id", "trigger_type", "trigger_time", "prompt_id", "is_enabled", "deleted_at") SELECT "id", "trigger_type", "trigger_time", "prompt_id", "is_enabled", "deleted_at" FROM `triggers`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_id_unique` ON `triggers` (`id`);--> statement-breakpoint

PRAGMA foreign_keys=ON;--> statement-breakpoint

-- Partial indexes for soft delete queries (only index active records)
CREATE INDEX `idx_chat_messages_active` ON `chat_messages` (`chat_thread_id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_chat_threads_active` ON `chat_threads` (`id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_active` ON `tasks` (`id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_models_active` ON `models` (`id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_prompts_active` ON `prompts` (`id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_triggers_active` ON `triggers` (`prompt_id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_mcp_servers_active` ON `mcp_servers` (`id`) WHERE `deleted_at` IS NULL;

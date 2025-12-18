CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`parts` text,
	`chat_thread_id` text DEFAULT '' NOT NULL,
	`model_id` text,
	`parent_id` text,
	`cache` text,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`is_encrypted` integer DEFAULT 0 NOT NULL,
	`triggered_by` text,
	`was_triggered_by_automation` integer DEFAULT 0 NOT NULL,
	`context_size` integer
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'http' NOT NULL,
	`url` text,
	`command` text,
	`args` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'custom' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`url` text,
	`api_key` text,
	`is_system` integer DEFAULT 0,
	`enabled` integer DEFAULT 1 NOT NULL,
	`tool_usage` integer DEFAULT 1 NOT NULL,
	`is_confidential` integer DEFAULT 0 NOT NULL,
	`start_with_reasoning` integer DEFAULT 0 NOT NULL,
	`supports_parallel_tool_calls` integer DEFAULT 1 NOT NULL,
	`context_window` integer,
	`deleted_at` integer,
	`default_hash` text,
	`vendor` text,
	`description` text
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`prompt` text DEFAULT '' NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`deleted_at` integer,
	`default_hash` text
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer DEFAULT (unixepoch()),
	`default_hash` text
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`item` text DEFAULT '' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT 0 NOT NULL,
	`default_hash` text
);
--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_type` text DEFAULT 'time' NOT NULL,
	`trigger_time` text,
	`prompt_id` text DEFAULT '' NOT NULL,
	`is_enabled` integer DEFAULT 1 NOT NULL
);

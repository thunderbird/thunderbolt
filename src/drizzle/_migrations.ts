/**
 * This file is auto-generated. Do not edit directly.
 */

export interface Migration {
  hash: string
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    hash: '0000_nice_mandroid',
    name: '0000_nice_mandroid.sql',
    sql: "CREATE TABLE `chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text DEFAULT '' NOT NULL,\n\t`role` text DEFAULT 'user' NOT NULL,\n\t`parts` text,\n\t`chat_thread_id` text DEFAULT '' NOT NULL,\n\t`model_id` text,\n\t`parent_id` text,\n\t`cache` text,\n\t`metadata` text\n);\n--> statement-breakpoint\nCREATE TABLE `chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text,\n\t`is_encrypted` integer DEFAULT 0 NOT NULL,\n\t`triggered_by` text,\n\t`was_triggered_by_automation` integer DEFAULT 0 NOT NULL,\n\t`context_size` integer\n);\n--> statement-breakpoint\nCREATE TABLE `mcp_servers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text DEFAULT '' NOT NULL,\n\t`type` text DEFAULT 'http' NOT NULL,\n\t`url` text,\n\t`command` text,\n\t`args` text,\n\t`enabled` integer DEFAULT 1 NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch()),\n\t`updated_at` integer DEFAULT (unixepoch())\n);\n--> statement-breakpoint\nCREATE TABLE `models` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`provider` text DEFAULT 'custom' NOT NULL,\n\t`name` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`url` text,\n\t`api_key` text,\n\t`is_system` integer DEFAULT 0,\n\t`enabled` integer DEFAULT 1 NOT NULL,\n\t`tool_usage` integer DEFAULT 1 NOT NULL,\n\t`is_confidential` integer DEFAULT 0 NOT NULL,\n\t`start_with_reasoning` integer DEFAULT 0 NOT NULL,\n\t`supports_parallel_tool_calls` integer DEFAULT 1 NOT NULL,\n\t`context_window` integer,\n\t`deleted_at` integer,\n\t`default_hash` text,\n\t`vendor` text,\n\t`description` text\n);\n--> statement-breakpoint\nCREATE TABLE `prompts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text,\n\t`prompt` text DEFAULT '' NOT NULL,\n\t`model_id` text DEFAULT '' NOT NULL,\n\t`deleted_at` integer,\n\t`default_hash` text\n);\n--> statement-breakpoint\nCREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`updated_at` integer DEFAULT (unixepoch()),\n\t`default_hash` text\n);\n--> statement-breakpoint\nCREATE TABLE `tasks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`item` text DEFAULT '' NOT NULL,\n\t`order` integer DEFAULT 0 NOT NULL,\n\t`is_complete` integer DEFAULT 0 NOT NULL,\n\t`default_hash` text\n);\n--> statement-breakpoint\nCREATE TABLE `triggers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`trigger_type` text DEFAULT 'time' NOT NULL,\n\t`trigger_time` text,\n\t`prompt_id` text DEFAULT '' NOT NULL,\n\t`is_enabled` integer DEFAULT 1 NOT NULL\n);",
  },
]

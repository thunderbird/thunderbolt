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
    hash: '0000_damp_shaman',
    name: '0000_damp_shaman.sql',
    sql: "CREATE TABLE `accounts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`type` text NOT NULL,\n\t`imap_hostname` text,\n\t`imap_port` integer,\n\t`imap_username` text,\n\t`imap_password` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `accounts_id_unique` ON `accounts` (`id`);--> statement-breakpoint\nCREATE TABLE `chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text NOT NULL,\n\t`role` text NOT NULL,\n\t`parts` text,\n\t`chat_thread_id` text NOT NULL,\n\tFOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint\nCREATE TABLE `chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text,\n\t`is_encrypted` integer DEFAULT 0 NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `contacts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`first_seen_at` integer NOT NULL,\n\t`last_seen_at` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `contacts_id_unique` ON `contacts` (`id`);--> statement-breakpoint\nCREATE TABLE `email_addresses` (\n\t`address` text PRIMARY KEY NOT NULL,\n\t`name` text,\n\t`contact_id` text,\n\t`first_seen_at` integer NOT NULL,\n\t`last_seen_at` integer NOT NULL,\n\tFOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE cascade ON DELETE set null\n);\n--> statement-breakpoint\nCREATE TABLE `email_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`imap_id` text NOT NULL,\n\t`html_body` text NOT NULL,\n\t`text_body` text NOT NULL,\n\t`parts` text,\n\t`subject` text,\n\t`sent_at` integer NOT NULL,\n\t`from_address` text NOT NULL,\n\t`email_thread_id` text NOT NULL,\n\t`mailbox` text NOT NULL,\n\t`references` text,\n\tFOREIGN KEY (`from_address`) REFERENCES `email_addresses`(`address`) ON UPDATE cascade ON DELETE restrict,\n\tFOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_id_unique` ON `email_messages` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_imap_id_unique` ON `email_messages` (`imap_id`);--> statement-breakpoint\nCREATE TABLE `email_messages_to_addresses` (\n\t`email_message_id` text NOT NULL,\n\t`email_address_id` text NOT NULL,\n\t`type` text NOT NULL,\n\tPRIMARY KEY(`email_message_id`, `email_address_id`),\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade,\n\tFOREIGN KEY (`email_address_id`) REFERENCES `email_addresses`(`address`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE TABLE `email_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`subject` text NOT NULL,\n\t`root_imap_id` text,\n\t`first_message_at` integer NOT NULL,\n\t`last_message_at` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_threads_id_unique` ON `email_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `embeddings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`email_message_id` text,\n\t`email_thread_id` text,\n\t`embedding` F32_BLOB(384),\n\t`as_text` text,\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade,\n\tFOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_id_unique` ON `embeddings` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_message_id_unique` ON `embeddings` (`email_message_id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_thread_id_unique` ON `embeddings` (`email_thread_id`);--> statement-breakpoint\nCREATE TABLE `mcp_servers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`type` text DEFAULT 'http' NOT NULL,\n\t`url` text,\n\t`command` text,\n\t`args` text,\n\t`enabled` integer DEFAULT 1 NOT NULL,\n\t`created_at` integer DEFAULT (unixepoch()),\n\t`updated_at` integer DEFAULT (unixepoch())\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `mcp_servers_id_unique` ON `mcp_servers` (`id`);--> statement-breakpoint\nCREATE TABLE `models` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`provider` text NOT NULL,\n\t`name` text NOT NULL,\n\t`model` text NOT NULL,\n\t`url` text,\n\t`api_key` text,\n\t`is_system` integer DEFAULT 0,\n\t`enabled` integer DEFAULT 1 NOT NULL,\n\t`tool_usage` integer DEFAULT 1 NOT NULL,\n\t`is_confidential` integer DEFAULT 0 NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `models_id_unique` ON `models` (`id`);--> statement-breakpoint\nCREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`updated_at` integer DEFAULT (unixepoch())\n);\n--> statement-breakpoint\nCREATE TABLE `tasks` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`item` text NOT NULL,\n\t`email_message_id` text,\n\t`order` integer DEFAULT 0 NOT NULL,\n\t`is_complete` integer DEFAULT 0 NOT NULL,\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `tasks_email_message_id_unique` ON `tasks` (`email_message_id`);",
  },
  {
    hash: '0001_shocking_mac_gargan',
    name: '0001_shocking_mac_gargan.sql',
    sql: 'CREATE TABLE `prompts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text,\n\t`prompt` text NOT NULL,\n\t`model_id` text NOT NULL,\n\tFOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `prompts_id_unique` ON `prompts` (`id`);--> statement-breakpoint\nCREATE TABLE `triggers` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`trigger_type` text NOT NULL,\n\t`trigger_time` text,\n\t`prompt_id` text NOT NULL,\n\t`is_enabled` integer DEFAULT 1 NOT NULL,\n\tFOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `triggers_id_unique` ON `triggers` (`id`);--> statement-breakpoint\nALTER TABLE `chat_threads` ADD `triggered_by` text REFERENCES prompts(id);',
  },
  {
    hash: '0002_zippy_squadron_sinister',
    name: '0002_zippy_squadron_sinister.sql',
    sql: 'ALTER TABLE `chat_messages` ADD `model_id` text REFERENCES models(id);',
  },
  {
    hash: '0003_warm_brood',
    name: '0003_warm_brood.sql',
    sql: 'ALTER TABLE `chat_threads` ADD `context_size` integer;--> statement-breakpoint\nALTER TABLE `models` ADD `start_with_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint\nALTER TABLE `models` ADD `context_window` integer;',
  },
  {
    hash: '0004_pale_winter_soldier',
    name: '0004_pale_winter_soldier.sql',
    sql: 'ALTER TABLE `chat_threads` ADD `was_triggered_by_automation` integer DEFAULT 0 NOT NULL;',
  },
  {
    hash: '0005_abandoned_toad_men',
    name: '0005_abandoned_toad_men.sql',
    sql: 'PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text,\n\t`is_encrypted` integer DEFAULT 0 NOT NULL,\n\t`triggered_by` text,\n\t`was_triggered_by_automation` integer DEFAULT 0 NOT NULL,\n\t`context_size` integer,\n\tFOREIGN KEY (`triggered_by`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null\n);\n--> statement-breakpoint\nINSERT INTO `__new_chat_threads`("id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size") SELECT "id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size" FROM `chat_threads`;--> statement-breakpoint\nDROP TABLE `chat_threads`;--> statement-breakpoint\nALTER TABLE `__new_chat_threads` RENAME TO `chat_threads`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);',
  },
]

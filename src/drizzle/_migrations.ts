/**
 * This file is auto-generated. Do not edit directly.
 * Generated on: 2025-03-21T02:17:47.783Z
 */

export interface Migration {
  hash: string;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    "hash": "0000_grey_random",
    "name": "0000_grey_random.sql",
    "sql": "CREATE TABLE `chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text NOT NULL,\n\t`attachments` text,\n\t`role` text NOT NULL,\n\t`annotations` text,\n\t`parts` text,\n\t`chat_thread_id` text NOT NULL,\n\tFOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE no action\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint\nCREATE TABLE `chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`updated_at` text DEFAULT (CURRENT_DATE)\n);"
  },
  {
    "hash": "0001_flimsy_kat_farrell",
    "name": "0001_flimsy_kat_farrell.sql",
    "sql": "CREATE TABLE `email_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`message_id` text NOT NULL,\n\t`html_body` text NOT NULL,\n\t`text_body` text NOT NULL,\n\t`parts` text NOT NULL,\n\t`subject` text,\n\t`date` text NOT NULL,\n\t`from` text NOT NULL,\n\t`in_reply_to` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_id_unique` ON `email_messages` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_message_id_unique` ON `email_messages` (`message_id`);"
  },
  {
    "hash": "0002_bouncy_zaran",
    "name": "0002_bouncy_zaran.sql",
    "sql": "CREATE TABLE `embeddings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`email_message_id` text,\n\t`embedding` F32_BLOB(768),\n\t`created_at` text DEFAULT (CURRENT_TIMESTAMP),\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_id_unique` ON `embeddings` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_message_id_unique` ON `embeddings` (`email_message_id`);--> statement-breakpoint\nPRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text NOT NULL,\n\t`attachments` text,\n\t`role` text NOT NULL,\n\t`annotations` text,\n\t`parts` text,\n\t`chat_thread_id` text NOT NULL,\n\tFOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nINSERT INTO `__new_chat_messages`(\"id\", \"content\", \"attachments\", \"role\", \"annotations\", \"parts\", \"chat_thread_id\") SELECT \"id\", \"content\", \"attachments\", \"role\", \"annotations\", \"parts\", \"chat_thread_id\" FROM `chat_messages`;--> statement-breakpoint\nDROP TABLE `chat_messages`;--> statement-breakpoint\nALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);"
  },
  {
    "hash": "0003_first_exiles",
    "name": "0003_first_exiles.sql",
    "sql": "ALTER TABLE `embeddings` DROP COLUMN `created_at`;"
  },
  {
    "hash": "0004_dizzy_war_machine",
    "name": "0004_dizzy_war_machine.sql",
    "sql": "-- Custom SQL migration file, put your code below! --\n\nCREATE INDEX IF NOT EXISTS embeddings_test_index ON embeddings (libsql_vector_idx(embedding));"
  }
];

/**
 * This file is auto-generated. Do not edit directly.
 * Generated on: 2025-03-25T19:34:40.554Z
 */

export interface Migration {
  hash: string;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    "hash": "0000_left_harrier",
    "name": "0000_left_harrier.sql",
    "sql": "CREATE TABLE `chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text NOT NULL,\n\t`attachments` text,\n\t`role` text NOT NULL,\n\t`annotations` text,\n\t`parts` text,\n\t`chat_thread_id` text NOT NULL,\n\tFOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint\nCREATE TABLE `chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `email_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`message_id` text NOT NULL,\n\t`html_body` text NOT NULL,\n\t`text_body` text NOT NULL,\n\t`parts` text NOT NULL,\n\t`subject` text,\n\t`date` text NOT NULL,\n\t`from` text NOT NULL,\n\t`in_reply_to` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_id_unique` ON `email_messages` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_message_id_unique` ON `email_messages` (`message_id`);--> statement-breakpoint\nCREATE TABLE `embeddings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`email_message_id` text,\n\t`embedding` F32_BLOB(384),\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_id_unique` ON `embeddings` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_message_id_unique` ON `embeddings` (`email_message_id`);--> statement-breakpoint\nCREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`updated_at` text DEFAULT (CURRENT_DATE)\n);"
  },
  {
    "hash": "0001_furry_rattler",
    "name": "0001_furry_rattler.sql",
    "sql": "CREATE TABLE `email_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`subject` text NOT NULL,\n\t`date` text NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_threads_id_unique` ON `email_threads` (`id`);--> statement-breakpoint\nALTER TABLE `email_messages` ADD `email_thread_id` text REFERENCES email_threads(id);--> statement-breakpoint\nALTER TABLE `embeddings` ADD `email_thread_id` text REFERENCES email_threads(id);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_thread_id_unique` ON `embeddings` (`email_thread_id`);"
  },
  {
    "hash": "0002_smiling_marauders",
    "name": "0002_smiling_marauders.sql",
    "sql": "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_email_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`message_id` text NOT NULL,\n\t`html_body` text NOT NULL,\n\t`text_body` text NOT NULL,\n\t`parts` text NOT NULL,\n\t`subject` text,\n\t`date` text NOT NULL,\n\t`from` text NOT NULL,\n\t`in_reply_to` text,\n\t`email_thread_id` text,\n\tFOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE set null\n);\n--> statement-breakpoint\nINSERT INTO `__new_email_messages`(\"id\", \"message_id\", \"html_body\", \"text_body\", \"parts\", \"subject\", \"date\", \"from\", \"in_reply_to\", \"email_thread_id\") SELECT \"id\", \"message_id\", \"html_body\", \"text_body\", \"parts\", \"subject\", \"date\", \"from\", \"in_reply_to\", \"email_thread_id\" FROM `email_messages`;--> statement-breakpoint\nDROP TABLE `email_messages`;--> statement-breakpoint\nALTER TABLE `__new_email_messages` RENAME TO `email_messages`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_id_unique` ON `email_messages` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_message_id_unique` ON `email_messages` (`message_id`);"
  },
  {
    "hash": "0003_mute_tigra",
    "name": "0003_mute_tigra.sql",
    "sql": "ALTER TABLE `email_threads` ADD `as_text` text NOT NULL;"
  },
  {
    "hash": "0004_spotty_kat_farrell",
    "name": "0004_spotty_kat_farrell.sql",
    "sql": "ALTER TABLE `embeddings` ADD `as_text` text;--> statement-breakpoint\nALTER TABLE `email_threads` DROP COLUMN `as_text`;"
  },
  {
    "hash": "0005_striped_ultimates",
    "name": "0005_striped_ultimates.sql",
    "sql": "ALTER TABLE `email_threads` ADD `root_message_id` text;"
  }
];

/**
 * This file is auto-generated. Do not edit directly.
 * Generated on: 2025-03-18T17:26:15.566Z
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
  }
];

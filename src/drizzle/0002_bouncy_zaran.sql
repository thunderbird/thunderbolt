CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`email_message_id` text,
	`embedding` F32_BLOB(768),
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_id_unique` ON `embeddings` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_email_message_id_unique` ON `embeddings` (`email_message_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`attachments` text,
	`role` text NOT NULL,
	`annotations` text,
	`parts` text,
	`chat_thread_id` text NOT NULL,
	FOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "content", "attachments", "role", "annotations", "parts", "chat_thread_id") SELECT "id", "content", "attachments", "role", "annotations", "parts", "chat_thread_id" FROM `chat_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);
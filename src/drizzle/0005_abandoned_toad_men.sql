PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`is_encrypted` integer DEFAULT 0 NOT NULL,
	`triggered_by` text,
	`was_triggered_by_automation` integer DEFAULT 0 NOT NULL,
	`context_size` integer,
	FOREIGN KEY (`triggered_by`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_chat_threads`("id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size") SELECT "id", "title", "is_encrypted", "triggered_by", "was_triggered_by_automation", "context_size" FROM `chat_threads`;--> statement-breakpoint
DROP TABLE `chat_threads`;--> statement-breakpoint
ALTER TABLE `__new_chat_threads` RENAME TO `chat_threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);
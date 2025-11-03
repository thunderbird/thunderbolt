PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `accounts`;--> statement-breakpoint
DROP TABLE `contacts`;--> statement-breakpoint
DROP TABLE `email_addresses`;--> statement-breakpoint
DROP TABLE `email_messages`;--> statement-breakpoint
DROP TABLE `email_messages_to_addresses`;--> statement-breakpoint
DROP TABLE `email_threads`;--> statement-breakpoint
DROP TABLE `embeddings`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`item` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`is_complete` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `item`, `order`, `is_complete`) SELECT `id`, `item`, `order`, `is_complete` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_id_unique` ON `tasks` (`id`);
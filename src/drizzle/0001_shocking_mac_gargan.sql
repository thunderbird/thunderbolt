CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`prompt` text NOT NULL,
	`model_id` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_id_unique` ON `prompts` (`id`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_time` text,
	`prompt_id` text NOT NULL,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_id_unique` ON `triggers` (`id`);--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `triggered_by` text REFERENCES prompts(id);
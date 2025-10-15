ALTER TABLE `models` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `default_hash` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `prompts` ADD `default_hash` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `default_hash` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `default_hash` text;
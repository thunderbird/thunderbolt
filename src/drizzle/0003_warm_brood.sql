ALTER TABLE `chat_threads` ADD `context_size` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `start_with_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `context_window` integer;
ALTER TABLE `chat_messages` ADD `tokens_actual` integer;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `tokens_estimate` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `context_window` integer;--> statement-breakpoint
ALTER TABLE `models` ADD `tokenizer` text;
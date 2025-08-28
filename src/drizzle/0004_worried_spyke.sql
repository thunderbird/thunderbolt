ALTER TABLE `chat_threads` ADD `context_size` integer;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `tokens_actual`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `tokens_estimate`;
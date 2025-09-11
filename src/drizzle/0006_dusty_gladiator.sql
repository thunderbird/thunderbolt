CREATE TABLE `feature_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text,
	`description` text,
	`documentation_url` text,
	`stage` text,
	`synced_at` integer DEFAULT (unixepoch()),
	`is_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch())
);

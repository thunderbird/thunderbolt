CREATE TABLE `model_profiles` (
	`model_id` text PRIMARY KEY NOT NULL,
	`temperature` real,
	`max_steps` integer,
	`max_attempts` integer,
	`nudge_threshold` integer,
	`use_system_message_mode_developer` integer DEFAULT 0,
	`tools_override` text,
	`link_previews_override` text,
	`chat_mode_addendum` text,
	`search_mode_addendum` text,
	`research_mode_addendum` text,
	`citation_reinforcement_enabled` integer DEFAULT 0,
	`citation_reinforcement_prompt` text,
	`nudge_final_step` text,
	`nudge_preventive` text,
	`nudge_retry` text,
	`nudge_search_final_step` text,
	`nudge_search_preventive` text,
	`nudge_search_retry` text,
	`provider_options` text,
	`default_hash` text,
	`deleted_at` integer,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_model_profiles_active` ON `model_profiles` (`model_id`) WHERE "model_profiles"."deleted_at" IS NULL;
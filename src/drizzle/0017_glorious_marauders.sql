-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE `modes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`icon` text NOT NULL,
	`system_prompt` text,
	`is_default` integer DEFAULT 0,
	`order` integer DEFAULT 0,
	`default_hash` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modes_id_unique` ON `modes` (`id`);--> statement-breakpoint
CREATE INDEX `idx_modes_active` ON `modes` (`id`) WHERE "modes"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `mode_id` text REFERENCES modes(id);
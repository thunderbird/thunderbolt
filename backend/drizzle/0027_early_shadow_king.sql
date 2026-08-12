-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."project_files" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "powersync"."projects" ADD COLUMN "agent_notes_enabled" integer DEFAULT 0;
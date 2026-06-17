-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."agents" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;
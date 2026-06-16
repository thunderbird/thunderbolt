-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."workspaces" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "powersync"."workspaces" ADD COLUMN "icon" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_slug" ON "powersync"."workspaces" USING btree ("slug") WHERE "powersync"."workspaces"."slug" IS NOT NULL;
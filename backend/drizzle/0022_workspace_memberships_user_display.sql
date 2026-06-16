-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."workspace_memberships" ADD COLUMN "user_name" text;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_memberships" ADD COLUMN "user_email" text;--> statement-breakpoint
UPDATE "powersync"."workspace_memberships" AS m
SET "user_name" = u."name", "user_email" = u."email"
FROM "user" AS u
WHERE m."user_id" = u."id";

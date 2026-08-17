-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"instructions" text,
	"icon" text,
	"pinned_order" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"deleted_at" timestamp,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."projects" ADD CONSTRAINT "projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_projects_user_id" ON "powersync"."projects" USING btree ("user_id");
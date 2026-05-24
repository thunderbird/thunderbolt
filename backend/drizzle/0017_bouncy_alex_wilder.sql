-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."skills" (
	"id" text NOT NULL,
	"name" text,
	"description" text,
	"instruction" text,
	"enabled" integer DEFAULT 1,
	"pinned_order" integer,
	"deleted_at" timestamp,
	"default_hash" text,
	"user_id" text NOT NULL,
	CONSTRAINT "skills_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD CONSTRAINT "skills_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skills_user_id" ON "powersync"."skills" USING btree ("user_id");
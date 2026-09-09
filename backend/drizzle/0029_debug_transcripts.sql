-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "debug_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"user_note" text,
	"client_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debug_transcripts" ADD CONSTRAINT "debug_transcripts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_debug_transcripts_user_id_created_at" ON "debug_transcripts" USING btree ("user_id","created_at");
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "debug_transcript_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "debug_transcript_clients_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "debug_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"local_user_id" text,
	"thread_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"user_note" text,
	"client_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debug_transcripts" ADD CONSTRAINT "debug_transcripts_client_id_debug_transcript_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."debug_transcript_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_transcripts" ADD CONSTRAINT "debug_transcripts_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_debug_transcripts_client_id_created_at" ON "debug_transcripts" USING btree ("client_id","created_at");
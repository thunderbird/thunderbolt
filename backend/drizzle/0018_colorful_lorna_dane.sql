-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."agents" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"transport" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"icon" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "agents_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "acp_session_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "powersync"."agents" USING btree ("user_id");
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."model_profiles" (
	"id" text NOT NULL,
	"temperature" real,
	"max_steps" integer,
	"max_attempts" integer,
	"nudge_threshold" integer,
	"use_system_message_mode_developer" integer DEFAULT 0,
	"tools_override" text,
	"link_previews_override" text,
	"chat_mode_addendum" text,
	"search_mode_addendum" text,
	"research_mode_addendum" text,
	"citation_reinforcement_enabled" integer DEFAULT 0,
	"citation_reinforcement_prompt" text,
	"nudge_final_step" text,
	"nudge_preventive" text,
	"nudge_retry" text,
	"nudge_search_final_step" text,
	"nudge_search_preventive" text,
	"nudge_search_retry" text,
	"provider_options" text,
	"default_hash" text,
	"deleted_at" timestamp,
	"user_id" text NOT NULL,
	CONSTRAINT "model_profiles_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_profiles_user_id" ON "powersync"."model_profiles" USING btree ("user_id");
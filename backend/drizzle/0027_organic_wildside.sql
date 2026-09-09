-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "inference_prices" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_nano_usd_per_token" bigint NOT NULL,
	"output_nano_usd_per_token" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_prices_provider_model_pk" PRIMARY KEY("provider","model"),
	CONSTRAINT "inference_prices_input_nonnegative" CHECK ("inference_prices"."input_nano_usd_per_token" >= 0),
	CONSTRAINT "inference_prices_output_nonnegative" CHECK ("inference_prices"."output_nano_usd_per_token" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inference_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"cost_nano_usd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_usage_prompt_nonnegative" CHECK ("inference_usage"."prompt_tokens" >= 0),
	CONSTRAINT "inference_usage_completion_nonnegative" CHECK ("inference_usage"."completion_tokens" >= 0),
	CONSTRAINT "inference_usage_total_nonnegative" CHECK ("inference_usage"."total_tokens" >= 0),
	CONSTRAINT "inference_usage_cost_nonnegative" CHECK ("inference_usage"."cost_nano_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inference_usage" ADD CONSTRAINT "inference_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_usage_user_id_created_at_idx" ON "inference_usage" USING btree ("user_id","created_at");
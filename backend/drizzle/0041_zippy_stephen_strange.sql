-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."cloud_agent_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" text,
	"payload" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_connection_oauth" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state_digest" text NOT NULL,
	"connection_version" integer NOT NULL,
	"key_epoch" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_connection_oauth_state_digest_unique" UNIQUE("state_digest")
);
--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD COLUMN "credential_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."cloud_agent_projections" ADD CONSTRAINT "cloud_agent_projections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connection_oauth" ADD CONSTRAINT "cloud_connection_oauth_connection_id_cloud_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connection_oauth" ADD CONSTRAINT "cloud_connection_oauth_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_agent_projections_user_id" ON "powersync"."cloud_agent_projections" USING btree ("user_id");
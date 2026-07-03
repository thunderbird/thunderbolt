-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."providers" (
	"id" text NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"base_url" text,
	"enabled_capabilities" text,
	"enabled" integer DEFAULT 1,
	"deleted_at" timestamp,
	"default_hash" text,
	"user_id" text,
	"workspace_id" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	CONSTRAINT "providers_id_workspace_id_pk" PRIMARY KEY("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."providers" ADD CONSTRAINT "providers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."providers" ADD CONSTRAINT "providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_providers_user_id" ON "powersync"."providers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_providers_workspace_id" ON "powersync"."providers" USING btree ("workspace_id");
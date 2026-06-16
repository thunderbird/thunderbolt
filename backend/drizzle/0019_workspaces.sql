-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."workspace_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "powersync"."workspace_pending_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "powersync"."workspace_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"required_role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "powersync"."workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "powersync"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_pending_memberships" ADD CONSTRAINT "workspace_pending_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_pending_memberships" ADD CONSTRAINT "workspace_pending_memberships_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_permissions" ADD CONSTRAINT "workspace_permissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspaces" ADD CONSTRAINT "workspaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_memberships_workspace_user" ON "powersync"."workspace_memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memberships_user" ON "powersync"."workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memberships_workspace" ON "powersync"."workspace_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_pending_memberships_workspace_email" ON "powersync"."workspace_pending_memberships" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "idx_workspace_pending_memberships_email" ON "powersync"."workspace_pending_memberships" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_workspace_pending_memberships_workspace" ON "powersync"."workspace_pending_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_permissions_workspace_key" ON "powersync"."workspace_permissions" USING btree ("workspace_id","permission_key");--> statement-breakpoint
CREATE INDEX "idx_workspace_permissions_workspace" ON "powersync"."workspace_permissions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_personal_per_owner" ON "powersync"."workspaces" USING btree ("owner_user_id") WHERE "powersync"."workspaces"."is_personal" = true;--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner_user_id" ON "powersync"."workspaces" USING btree ("owner_user_id");
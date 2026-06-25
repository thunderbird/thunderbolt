-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Workspaces v1 foundation: create the workspace identity tables and
-- materialize one Personal Workspace + admin membership per existing user.
--
-- Run BEFORE 0021 (the per-user data tables migration) so that:
--   - the workspaces row exists when 0021's UPDATE backfills workspace_id
--     from user_id (computed via uuid_generate_v5);
--   - 0021's workspace_id NOT NULL + FK constraints land on populated
--     tables without a TRUNCATE step (sync-rule update would otherwise
--     wipe stale clients' local data on next sync).
--
-- Personal workspace ids are derived deterministically from user.id via
-- uuid_generate_v5 over the namespace defined in shared/workspaces.ts:
--   computePersonalWorkspaceId(userId) =
--     uuid_generate_v5(NAMESPACE, 'personal:' || userId)
--   computePersonalAdminMembershipId(userId) =
--     uuid_generate_v5(NAMESPACE, 'personal-admin:' || userId)
-- The same constants are reused by the FE bootstrap and the BE upload
-- handler — multi-device upserts collapse to the same row id.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";--> statement-breakpoint

CREATE TABLE "powersync"."workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"icon" text,
	"is_personal" boolean DEFAULT false NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "powersync"."workspace_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"user_name" text,
	"user_email" text,
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
ALTER TABLE "powersync"."workspaces" ADD CONSTRAINT "workspaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_pending_memberships" ADD CONSTRAINT "workspace_pending_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_pending_memberships" ADD CONSTRAINT "workspace_pending_memberships_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_permissions" ADD CONSTRAINT "workspace_permissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_personal_per_owner" ON "powersync"."workspaces" USING btree ("owner_user_id") WHERE "powersync"."workspaces"."is_personal" = true;--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner_user_id" ON "powersync"."workspaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_slug" ON "powersync"."workspaces" USING btree ("slug") WHERE "powersync"."workspaces"."slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_memberships_workspace_user" ON "powersync"."workspace_memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memberships_user" ON "powersync"."workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_memberships_workspace" ON "powersync"."workspace_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_pending_memberships_workspace_email" ON "powersync"."workspace_pending_memberships" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "idx_workspace_pending_memberships_email" ON "powersync"."workspace_pending_memberships" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_workspace_pending_memberships_workspace" ON "powersync"."workspace_pending_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspace_permissions_workspace_key" ON "powersync"."workspace_permissions" USING btree ("workspace_id","permission_key");--> statement-breakpoint
CREATE INDEX "idx_workspace_permissions_workspace" ON "powersync"."workspace_permissions" USING btree ("workspace_id");--> statement-breakpoint
-- Backfill: one Personal Workspace per existing user.
INSERT INTO "powersync"."workspaces" ("id", "name", "is_personal", "owner_user_id", "created_at", "updated_at")
SELECT
  uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || u.id)::text,
  'Default',
  true,
  u.id,
  now(),
  now()
FROM "public"."user" u;
--> statement-breakpoint
-- Backfill: admin membership tying each user to their Personal Workspace.
-- user_name / user_email are denormalized from `auth.user` so the Members page
-- can render display info without a synced `users` projection.
INSERT INTO "powersync"."workspace_memberships" ("id", "workspace_id", "user_id", "role", "user_name", "user_email", "created_at")
SELECT
  uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal-admin:' || u.id)::text,
  uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || u.id)::text,
  u.id,
  'admin',
  u.name,
  u.email,
  now()
FROM "public"."user" u;

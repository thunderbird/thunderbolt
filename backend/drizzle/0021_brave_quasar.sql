-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Workspaces v1: foundation + data layer + models.api_key. Consolidated into a
-- single migration so the BE schema lands atomically — splitting it lets a
-- partial apply leave the DB with workspace_id NOT NULL columns but no
-- workspaces rows to FK to, or with workspaces tables but no backfilled data.
--
-- Phase 1 — Workspace identity:
--   create the workspace identity tables and materialize one Personal Workspace
--   + admin membership per existing user. Must run before phase 2 so the
--   workspaces row exists when phase 2's UPDATE backfills workspace_id from
--   user_id (computed via uuid_generate_v5).
--
-- Phase 2 — Per-user data tables get workspace_id:
--   Backfill instead of truncate so existing rows survive the cutover. Sync-rule
--   updates invalidate every connected client's checkpoint on first PowerSync
--   restart with the new schema — if BE returned empty buckets at that point,
--   every client (migrated or stale) would reconcile to "your bucket is empty"
--   and wipe its local copies. Backfilling keeps BE-side data continuous so
--   both shapes of clients see no interruption.
--
--   ORDER IS LOAD-BEARING: the backfill UPDATEs run BEFORE we drop the old
--   (id, user_id) composite PKs. The powersync.* tables are published for
--   logical replication and Postgres refuses UPDATEs on a published table that
--   has no REPLICA IDENTITY — dropping the PK first leaves the table with no
--   identity → `cannot update table … because it does not have a replica
--   identity and publishes updates`. So: add the column, populate it, THEN
--   swap PKs and FKs.
--
-- Phase 3 — models.api_key:
--   reintroduces the column dropped in THU-505; carried inside this migration
--   so the workspaces cutover ships the full v1 schema in one transaction.
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
--> statement-breakpoint

-- Tripwire: every per-user table backfills `workspace_id` from `user_id`, and
-- `uuid_generate_v5(NS, 'personal:' || NULL)` returns NULL — which would later
-- fail the `SET NOT NULL` flip below with a vague constraint-violation error
-- after most of the migration had already run. The pre-migration schema put
-- user_id NOT NULL on every row (composite PK on resource tables, FK-NOT-NULL
-- on chat tables), so any NULL here means a data invariant has already drifted
-- somewhere upstream. Abort loudly before we touch anything.
DO $$
DECLARE
  null_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "powersync"."agents"         WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."chat_messages"  WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."chat_threads"   WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."model_profiles" WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."models"         WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."modes"          WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."prompts"        WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."skills"         WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."tasks"          WHERE "user_id" IS NULL) +
    (SELECT count(*) FROM "powersync"."triggers"       WHERE "user_id" IS NULL)
  INTO null_count;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'pre-Workspaces backfill aborted: % rows have NULL user_id across powersync.* tables — workspace_id cannot be derived', null_count;
  END IF;
END $$;--> statement-breakpoint

-- ADD workspace_id columns as NULLABLE first so the UPDATE backfill can run
-- against existing rows. SET NOT NULL flips after the backfill below.
ALTER TABLE "powersync"."agents" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "workspace_id" text;--> statement-breakpoint

-- Scope columns default to 'workspace' so existing rows opt in implicitly;
-- the new 'user' scope (THU-603) is only ever set on rows authored after
-- workspaces v1 lands.
ALTER TABLE "powersync"."agents" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint

-- Backfill workspace_id from each row's user_id. Runs while the old
-- (id, user_id) composite PKs are still in place — those PKs are the tables'
-- replica identities, and PG requires one for UPDATEs on published tables.
-- Every row pre-migration had user_id NOT NULL (composite PK guaranteed it
-- for tasks/models/modes/etc.; chat tables were FK-NOT-NULL on user_id), so
-- every row gets stamped with its author's Personal Workspace id (computed
-- via uuid_generate_v5 with the same namespace as shared/workspaces.ts →
-- computePersonalWorkspaceId).
UPDATE "powersync"."agents"         SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."chat_messages"  SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."chat_threads"   SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."model_profiles" SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."models"         SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."modes"          SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."prompts"        SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."skills"         SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."tasks"          SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint
UPDATE "powersync"."triggers"       SET "workspace_id" = uuid_generate_v5('e2c4f9e0-b3a1-4a5c-9e8f-1d3a5c7e9f1b'::uuid, 'personal:' || "user_id")::text;--> statement-breakpoint

-- Flip workspace_id to NOT NULL now that every row is populated.
ALTER TABLE "powersync"."agents"         ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages"  ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads"   ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models"         ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes"          ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts"        ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills"         ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."tasks"          ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers"       ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint

-- Drop old user_id FKs + (id, user_id) composite PKs so we can relax user_id
-- NOT NULL on resource tables and re-shape the PK around workspace_id.
ALTER TABLE "powersync"."agents" DROP CONSTRAINT "agents_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."skills" DROP CONSTRAINT "skills_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."triggers" DROP CONSTRAINT "triggers_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."agents" DROP CONSTRAINT "agents_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."skills" DROP CONSTRAINT "skills_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."tasks" DROP CONSTRAINT "tasks_id_user_id_pk";--> statement-breakpoint

-- Resource tables relax user_id NOT NULL so shared-workspace rows can have a
-- null owner after the original author deletes their account (FK switches to
-- ON DELETE set null below). User-private tables (chat_threads, chat_messages,
-- tasks) keep user_id NOT NULL — those rows are useless without their author.
ALTER TABLE "powersync"."agents" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint

-- New composite PKs (id, workspace_id) — same id may repeat across workspaces
-- (e.g. seeded defaults), so workspace_id has to be part of the key.
ALTER TABLE "powersync"."agents"         ADD CONSTRAINT "agents_id_workspace_id_pk"         PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."models"         ADD CONSTRAINT "models_id_workspace_id_pk"         PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."modes"          ADD CONSTRAINT "modes_id_workspace_id_pk"          PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."prompts"        ADD CONSTRAINT "prompts_id_workspace_id_pk"        PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."skills"         ADD CONSTRAINT "skills_id_workspace_id_pk"         PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."tasks"          ADD CONSTRAINT "tasks_id_workspace_id_pk"          PRIMARY KEY("id","workspace_id");--> statement-breakpoint

-- Workspace FKs on every workspace-scoped table.
ALTER TABLE "powersync"."agents"         ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk"         FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages"  ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk"  FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads"   ADD CONSTRAINT "chat_threads_workspace_id_workspaces_id_fk"   FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models"         ADD CONSTRAINT "models_workspace_id_workspaces_id_fk"         FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes"          ADD CONSTRAINT "modes_workspace_id_workspaces_id_fk"          FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts"        ADD CONSTRAINT "prompts_workspace_id_workspaces_id_fk"        FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."skills"         ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk"         FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."tasks"          ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk"          FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers"       ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk"       FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Re-add user_id FKs. Resource tables move to ON DELETE set null so a shared
-- workspace's resources survive an author leaving / deleting their account.
ALTER TABLE "powersync"."agents"         ADD CONSTRAINT "agents_user_id_user_id_fk"         FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models"         ADD CONSTRAINT "models_user_id_user_id_fk"         FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes"          ADD CONSTRAINT "modes_user_id_user_id_fk"          FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts"        ADD CONSTRAINT "prompts_user_id_user_id_fk"        FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."skills"         ADD CONSTRAINT "skills_user_id_user_id_fk"         FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers"       ADD CONSTRAINT "triggers_user_id_user_id_fk"       FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- workspace_id indexes on every workspace-scoped table.
CREATE INDEX "idx_agents_workspace_id"         ON "powersync"."agents"         USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_workspace_id"  ON "powersync"."chat_messages"  USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_workspace_id"   ON "powersync"."chat_threads"   USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_model_profiles_workspace_id" ON "powersync"."model_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_models_workspace_id"         ON "powersync"."models"         USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_modes_workspace_id"          ON "powersync"."modes"          USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_prompts_workspace_id"        ON "powersync"."prompts"        USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_skills_workspace_id"         ON "powersync"."skills"         USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace_id"          ON "powersync"."tasks"          USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_triggers_workspace_id"       ON "powersync"."triggers"       USING btree ("workspace_id");--> statement-breakpoint

-- THU-579: reintroduce models.api_key (dropped in THU-505). Carried inside
-- the workspaces cutover so v1 lands as a single schema swap.
ALTER TABLE "powersync"."models" ADD COLUMN "api_key" text;

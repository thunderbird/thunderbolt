-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Workspaces v1 data layer: bind every per-user data row to the row owner's
-- Personal Workspace (created by 0020), then enforce workspace_id NOT NULL.
--
-- Backfill instead of truncate so existing rows survive the cutover. Sync-rule
-- updates invalidate every connected client's checkpoint on first PowerSync
-- restart with the new schema — if BE returned empty buckets at that point,
-- every client (migrated or stale) would reconcile to "your bucket is empty"
-- and wipe its local copies. Backfilling keeps BE-side data continuous so
-- both shapes of clients see no interruption.
--
-- ORDER IS LOAD-BEARING: the backfill UPDATEs run BEFORE we drop the old
-- (id, user_id) composite PKs. The powersync.* tables are published for
-- logical replication and Postgres refuses UPDATEs on a published table that
-- has no REPLICA IDENTITY — dropping the PK first leaves the table with no
-- identity → `cannot update table … because it does not have a replica
-- identity and publishes updates`. So: add the column, populate it, THEN
-- swap PKs and FKs.

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
CREATE INDEX "idx_triggers_workspace_id"       ON "powersync"."triggers"       USING btree ("workspace_id");

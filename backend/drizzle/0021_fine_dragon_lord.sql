-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

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
ALTER TABLE "powersync"."agents" DROP CONSTRAINT "agents_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."skills" DROP CONSTRAINT "skills_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."triggers" DROP CONSTRAINT "triggers_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."agents" DROP CONSTRAINT "agents_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."skills" DROP CONSTRAINT "skills_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."tasks" DROP CONSTRAINT "tasks_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."agents" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "scope" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD CONSTRAINT "skills_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
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
CREATE INDEX "idx_workspaces_owner_user_id" ON "powersync"."workspaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workspaces_slug" ON "powersync"."workspaces" USING btree ("slug") WHERE "powersync"."workspaces"."slug" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD CONSTRAINT "chat_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD CONSTRAINT "skills_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD CONSTRAINT "triggers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agents_workspace_id" ON "powersync"."agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_workspace_id" ON "powersync"."chat_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_workspace_id" ON "powersync"."chat_threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_model_profiles_workspace_id" ON "powersync"."model_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_models_workspace_id" ON "powersync"."models" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_modes_workspace_id" ON "powersync"."modes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_prompts_workspace_id" ON "powersync"."prompts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_skills_workspace_id" ON "powersync"."skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace_id" ON "powersync"."tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_triggers_workspace_id" ON "powersync"."triggers" USING btree ("workspace_id");
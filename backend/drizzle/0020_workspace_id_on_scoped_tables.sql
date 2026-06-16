-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Pre-release reset (per THU-550 addendum): existing rows on workspace-scoped tables
-- are wiped so the NOT NULL `workspace_id` column can be added without a backfill.
-- New rows are created against the user's personal workspace once the FE deploys.
DELETE FROM "powersync"."chat_messages";--> statement-breakpoint
DELETE FROM "powersync"."chat_threads";--> statement-breakpoint
DELETE FROM "powersync"."tasks";--> statement-breakpoint
DELETE FROM "powersync"."models";--> statement-breakpoint
DELETE FROM "powersync"."mcp_servers";--> statement-breakpoint
DELETE FROM "powersync"."prompts";--> statement-breakpoint
DELETE FROM "powersync"."skills";--> statement-breakpoint
DELETE FROM "powersync"."triggers";--> statement-breakpoint
DELETE FROM "powersync"."modes";--> statement-breakpoint
DELETE FROM "powersync"."model_profiles";--> statement-breakpoint
DELETE FROM "powersync"."agents";--> statement-breakpoint
ALTER TABLE "powersync"."agents" DROP CONSTRAINT "agents_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" DROP CONSTRAINT "mcp_servers_user_id_user_id_fk";
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
ALTER TABLE "powersync"."mcp_servers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."skills" ADD CONSTRAINT "skills_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."agents" ADD CONSTRAINT "agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD CONSTRAINT "chat_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "idx_mcp_servers_workspace_id" ON "powersync"."mcp_servers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_model_profiles_workspace_id" ON "powersync"."model_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_models_workspace_id" ON "powersync"."models" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_modes_workspace_id" ON "powersync"."modes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_prompts_workspace_id" ON "powersync"."prompts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_skills_workspace_id" ON "powersync"."skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace_id" ON "powersync"."tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_triggers_workspace_id" ON "powersync"."triggers" USING btree ("workspace_id");
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "cloud_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"key_epoch" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"owner_key_envelope" jsonb NOT NULL,
	"runtime_key_envelope" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"argument_digest" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_artifact_grants" (
	"artifact_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_kind" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"key_envelope" jsonb NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "cloud_artifact_grants_artifact_id_recipient_id_key_epoch_pk" PRIMARY KEY("artifact_id","recipient_id","key_epoch")
);
--> statement-breakpoint
CREATE TABLE "cloud_artifact_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"user_id" text NOT NULL,
	"parent_revision_id" text,
	"key_epoch" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"object_key" text NOT NULL,
	"digest" text NOT NULL,
	"byte_length" integer NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"current_revision_id" text,
	"key_epoch" integer NOT NULL,
	"owner_key_envelope" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_blob_cleanup" (
	"object_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delete_after" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"key_epoch" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"owner_key_envelope" jsonb NOT NULL,
	"runtime_key_envelope" jsonb NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"pi_conversation_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_identities" (
	"user_id" text PRIMARY KEY NOT NULL,
	"public_key" jsonb NOT NULL,
	"private_record" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"key_epoch" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"command_id" text NOT NULL,
	"command_digest" text NOT NULL,
	"content" jsonb NOT NULL,
	"key_epoch" integer NOT NULL,
	"config_version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"pi_submission_id" integer,
	"error_code" text,
	"reserved_micros" integer DEFAULT 0 NOT NULL,
	"spent_micros" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_runtime_document_revisions" (
	"namespace" text NOT NULL,
	"document_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "cloud_runtime_document_revisions_namespace_document_id_seq_pk" PRIMARY KEY("namespace","document_id","seq"),
	CONSTRAINT "cloud_runtime_revision_kind" CHECK ("cloud_runtime_document_revisions"."kind" in ('base', 'delta'))
);
--> statement-breakpoint
CREATE TABLE "cloud_runtime_namespaces" (
	"namespace" text PRIMARY KEY NOT NULL,
	"next_id" bigint DEFAULT 2 NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_runtime_records" (
	"namespace" text NOT NULL,
	"id" bigint NOT NULL,
	"record_type" text NOT NULL,
	"conversation_id" bigint,
	"owner_conversation_id" bigint,
	"owner_task_id" bigint,
	"kind_index" text,
	"status" text,
	"abort_requested" boolean,
	"background" boolean,
	"request_index" text,
	"scope_kind" text,
	"scope_owner_id" bigint,
	"address_index" text,
	"created_seq" bigint,
	"retired_seq" bigint,
	"head_id" bigint,
	"commit_seq" bigint NOT NULL,
	"payload" text NOT NULL,
	CONSTRAINT "cloud_runtime_records_namespace_id_pk" PRIMARY KEY("namespace","id"),
	CONSTRAINT "cloud_runtime_record_type" CHECK ("cloud_runtime_records"."record_type" in ('conversation', 'entry', 'task', 'submission', 'document'))
);
--> statement-breakpoint
CREATE TABLE "cloud_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"key_epoch" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"active_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_approvals" ADD CONSTRAINT "cloud_approvals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_approvals" ADD CONSTRAINT "cloud_approvals_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_approvals" ADD CONSTRAINT "cloud_approvals_run_id_cloud_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cloud_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_artifact_grants" ADD CONSTRAINT "cloud_artifact_grants_artifact_id_cloud_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."cloud_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_artifact_revisions" ADD CONSTRAINT "cloud_artifact_revisions_artifact_id_cloud_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."cloud_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_artifact_revisions" ADD CONSTRAINT "cloud_artifact_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_artifacts" ADD CONSTRAINT "cloud_artifacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_conversations" ADD CONSTRAINT "cloud_conversations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_conversations" ADD CONSTRAINT "cloud_conversations_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_identities" ADD CONSTRAINT "cloud_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_messages" ADD CONSTRAINT "cloud_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_messages" ADD CONSTRAINT "cloud_messages_conversation_id_cloud_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."cloud_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_messages" ADD CONSTRAINT "cloud_messages_run_id_cloud_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cloud_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_runs" ADD CONSTRAINT "cloud_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_runs" ADD CONSTRAINT "cloud_runs_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_runs" ADD CONSTRAINT "cloud_runs_conversation_id_cloud_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."cloud_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_runtime_document_revisions" ADD CONSTRAINT "cloud_runtime_document_revisions_namespace_cloud_runtime_namespaces_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "public"."cloud_runtime_namespaces"("namespace") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_runtime_records" ADD CONSTRAINT "cloud_runtime_records_namespace_cloud_runtime_namespaces_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "public"."cloud_runtime_namespaces"("namespace") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_schedules" ADD CONSTRAINT "cloud_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_schedules" ADD CONSTRAINT "cloud_schedules_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_agents_owner" ON "cloud_agents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_approvals_call" ON "cloud_approvals" USING btree ("run_id","call_id");--> statement-breakpoint
CREATE INDEX "cloud_artifact_revisions_artifact" ON "cloud_artifact_revisions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "cloud_artifacts_owner" ON "cloud_artifacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cloud_connections_owner" ON "cloud_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cloud_conversations_agent" ON "cloud_conversations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cloud_messages_conversation" ON "cloud_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_runs_command" ON "cloud_runs" USING btree ("user_id","command_id");--> statement-breakpoint
CREATE INDEX "cloud_runs_conversation" ON "cloud_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "cloud_runs_status" ON "cloud_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cloud_runtime_revisions_base_idx" ON "cloud_runtime_document_revisions" USING btree ("namespace","document_id","kind","seq");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_type_id_idx" ON "cloud_runtime_records" USING btree ("namespace","record_type","id");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_conversation_idx" ON "cloud_runtime_records" USING btree ("namespace","record_type","conversation_id","id");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_status_idx" ON "cloud_runtime_records" USING btree ("namespace","record_type","status","id");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_request_idx" ON "cloud_runtime_records" USING btree ("namespace","conversation_id","request_index");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_address_idx" ON "cloud_runtime_records" USING btree ("namespace","address_index","created_seq");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_scope_idx" ON "cloud_runtime_records" USING btree ("namespace","scope_kind","scope_owner_id","id");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_owner_conversation_idx" ON "cloud_runtime_records" USING btree ("namespace","owner_conversation_id","id");--> statement-breakpoint
CREATE INDEX "cloud_runtime_records_owner_task_idx" ON "cloud_runtime_records" USING btree ("namespace","owner_task_id","id");--> statement-breakpoint
CREATE INDEX "cloud_schedules_due" ON "cloud_schedules" USING btree ("next_run_at");
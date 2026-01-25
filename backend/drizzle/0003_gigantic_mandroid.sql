CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text,
	"role" text,
	"parts" text,
	"chat_thread_id" text,
	"model_id" text,
	"parent_id" text,
	"cache" text,
	"metadata" text,
	"deleted_at" integer,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"is_encrypted" integer DEFAULT 0,
	"triggered_by" text,
	"was_triggered_by_automation" integer DEFAULT 0,
	"context_size" integer,
	"deleted_at" integer,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"type" text DEFAULT 'http',
	"url" text,
	"command" text,
	"args" text,
	"enabled" integer DEFAULT 1,
	"created_at" integer DEFAULT extract(epoch from now())::integer,
	"updated_at" integer DEFAULT extract(epoch from now())::integer,
	"deleted_at" integer,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text,
	"name" text,
	"model" text,
	"url" text,
	"api_key" text,
	"is_system" integer DEFAULT 0,
	"enabled" integer DEFAULT 1,
	"tool_usage" integer DEFAULT 1,
	"is_confidential" integer DEFAULT 0,
	"start_with_reasoning" integer DEFAULT 0,
	"supports_parallel_tool_calls" integer DEFAULT 1,
	"context_window" integer,
	"deleted_at" integer,
	"default_hash" text,
	"vendor" text,
	"description" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"prompt" text,
	"model_id" text,
	"deleted_at" integer,
	"default_hash" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" integer DEFAULT extract(epoch from now())::integer,
	"default_hash" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text,
	"order" integer DEFAULT 0,
	"is_complete" integer DEFAULT 0,
	"default_hash" text,
	"deleted_at" integer,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_type" text,
	"trigger_time" text,
	"prompt_id" text,
	"is_enabled" integer DEFAULT 1,
	"deleted_at" integer,
	"user_id" text
);
--> statement-breakpoint
CREATE INDEX "idx_chat_messages_active" ON "chat_messages" USING btree ("chat_thread_id") WHERE "chat_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_chat_threads_active" ON "chat_threads" USING btree ("id") WHERE "chat_threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_active" ON "mcp_servers" USING btree ("id") WHERE "mcp_servers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_models_active" ON "models" USING btree ("id") WHERE "models"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_prompts_active" ON "prompts" USING btree ("id") WHERE "prompts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_tasks_active" ON "tasks" USING btree ("id") WHERE "tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_triggers_active" ON "triggers" USING btree ("prompt_id") WHERE "triggers"."deleted_at" IS NULL;
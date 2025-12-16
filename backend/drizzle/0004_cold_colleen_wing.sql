ALTER TABLE "chat_messages" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "deleted_at" integer;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "deleted_at" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "deleted_at" integer;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "deleted_at" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_at" integer;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "updated_at" integer;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "deleted_at" integer;
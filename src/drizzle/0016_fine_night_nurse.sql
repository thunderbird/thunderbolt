CREATE INDEX `idx_chat_messages_active` ON `chat_messages` (`chat_thread_id`) WHERE "chat_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_chat_threads_active` ON `chat_threads` (`id`) WHERE "chat_threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_mcp_servers_active` ON `mcp_servers` (`id`) WHERE "mcp_servers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_models_active` ON `models` (`id`) WHERE "models"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_prompts_active` ON `prompts` (`id`) WHERE "prompts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_active` ON `tasks` (`id`) WHERE "tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_triggers_active` ON `triggers` (`prompt_id`) WHERE "triggers"."deleted_at" IS NULL;
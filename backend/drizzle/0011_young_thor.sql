ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_parent_id_chat_messages_id_fk";

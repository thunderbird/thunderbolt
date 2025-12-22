ALTER TABLE "user" ADD COLUMN "sync_migration_version" text;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD COLUMN "migration_version" text;


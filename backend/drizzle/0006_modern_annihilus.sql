ALTER TABLE "user" ADD COLUMN "is_new" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "user" SET is_new = false;
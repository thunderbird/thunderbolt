CREATE TABLE "sync_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"table_name" text NOT NULL,
	"pk" text NOT NULL,
	"cid" text NOT NULL,
	"val" text,
	"col_version" bigint NOT NULL,
	"db_version" bigint NOT NULL,
	"cl" integer NOT NULL,
	"seq" integer NOT NULL,
	"site_id_raw" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"migration_version" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "sync_migration_version" text;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_changes_user_id_idx" ON "sync_changes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_changes_user_site_idx" ON "sync_changes" USING btree ("user_id","site_id");--> statement-breakpoint
CREATE INDEX "sync_changes_created_at_idx" ON "sync_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_devices_user_id_idx" ON "sync_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_devices_site_id_idx" ON "sync_devices" USING btree ("site_id");
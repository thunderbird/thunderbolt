CREATE TABLE "encryption_metadata" (
	"user_id" text PRIMARY KEY NOT NULL,
	"canary_iv" text NOT NULL,
	"canary_ctext" text NOT NULL,
	"canary_secret_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wrapped_ck" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "powersync"."devices" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."devices" ADD COLUMN "approval_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."devices" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD CONSTRAINT "encryption_metadata_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "powersync"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_envelopes_user_id" ON "envelopes" USING btree ("user_id");--> statement-breakpoint
UPDATE "powersync"."devices" SET "trusted" = true WHERE "revoked_at" IS NULL;
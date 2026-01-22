CREATE TABLE "waitlist" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"batch_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "waitlist_email_idx" ON "waitlist" USING btree ("email");--> statement-breakpoint
CREATE INDEX "waitlist_status_idx" ON "waitlist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "waitlist_batch_id_idx" ON "waitlist" USING btree ("batch_id");
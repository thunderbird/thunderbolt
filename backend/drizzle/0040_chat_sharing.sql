-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "powersync"."received_shares" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_name" text NOT NULL,
	"owner_email" text NOT NULL,
	"encrypted_title" text NOT NULL,
	"sealed_share_key" text NOT NULL,
	"inbox_version" integer NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "received_shares_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "powersync"."sent_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" text NOT NULL,
	"recipients" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_keys" (
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"key_id" text NOT NULL,
	"ecdh_public_key" text NOT NULL,
	"mlkem_public_key" text NOT NULL,
	"encrypted_seed" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_keys_user_id_version_pk" PRIMARY KEY("user_id","version")
);
--> statement-breakpoint
CREATE TABLE "chat_share_notifications" (
	"owner_user_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"chat_thread_id" text NOT NULL,
	"notified_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_share_notifications_owner_user_id_chat_thread_id_recipient_user_id_pk" PRIMARY KEY("owner_user_id","chat_thread_id","recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_share_recipients" (
	"share_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"inbox_version" integer NOT NULL,
	"sealed_share_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_share_recipients_share_id_recipient_user_id_pk" PRIMARY KEY("share_id","recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"chat_thread_id" text NOT NULL,
	"encrypted_snapshot" text NOT NULL,
	"encrypted_title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "powersync"."received_shares" ADD CONSTRAINT "received_shares_id_chat_shares_id_fk" FOREIGN KEY ("id") REFERENCES "public"."chat_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."received_shares" ADD CONSTRAINT "received_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."sent_shares" ADD CONSTRAINT "sent_shares_id_chat_shares_id_fk" FOREIGN KEY ("id") REFERENCES "public"."chat_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."sent_shares" ADD CONSTRAINT "sent_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_keys" ADD CONSTRAINT "inbox_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_share_notifications" ADD CONSTRAINT "chat_share_notifications_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_share_notifications" ADD CONSTRAINT "chat_share_notifications_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_share_recipients" ADD CONSTRAINT "chat_share_recipients_share_id_chat_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."chat_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_share_recipients" ADD CONSTRAINT "chat_share_recipients_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_shares" ADD CONSTRAINT "chat_shares_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_received_shares_user_id" ON "powersync"."received_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sent_shares_user_id" ON "powersync"."sent_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_share_notifications_recipient_user_id" ON "chat_share_notifications" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_share_recipients_recipient_user_id" ON "chat_share_recipients" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_shares_owner_user_id_chat_thread_id_uidx" ON "chat_shares" USING btree ("owner_user_id","chat_thread_id");
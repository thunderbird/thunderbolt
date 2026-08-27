-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "challenge_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"device_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wrapped_keys" (
	"key_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wrapped_keys_key_id_user_id_pk" PRIMARY KEY("key_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "signing_public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "kdf_salt" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "primary_key_id" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "scheme_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenge_nonces" ADD CONSTRAINT "challenge_nonces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrapped_keys" ADD CONSTRAINT "wrapped_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_challenge_nonces_user_id" ON "challenge_nonces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_wrapped_keys_user_id" ON "wrapped_keys" USING btree ("user_id");
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "passkey_credential_id" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "passkey_ecdh_public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "passkey_mlkem_public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "passkey_wrapped_ak" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "passkey_attestation" text;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "encryption_metadata" ADD COLUMN "recovery_ecdh_public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "recovery_mlkem_public_key" text;--> statement-breakpoint
ALTER TABLE "encryption_metadata" ADD COLUMN "recovery_wrapped_ak" text;
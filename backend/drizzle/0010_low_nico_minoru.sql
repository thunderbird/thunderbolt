-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "otp_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"challenge_token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_email_unique" UNIQUE("email")
);

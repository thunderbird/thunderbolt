-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

CREATE TABLE "device_approval_sessions" (
	"device_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"commitment" text NOT NULL,
	"challenge" text,
	"challenger_device_id" text,
	"reveal" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_approval_sessions" ADD CONSTRAINT "device_approval_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "powersync"."devices"("id") ON DELETE cascade ON UPDATE no action;
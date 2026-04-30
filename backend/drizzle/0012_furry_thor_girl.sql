-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "session" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX "session_deviceId_idx" ON "session" USING btree ("device_id");
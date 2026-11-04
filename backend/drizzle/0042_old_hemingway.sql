-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "cloud_agents" ADD COLUMN "save_digest" text;--> statement-breakpoint
ALTER TABLE "cloud_schedules" ADD COLUMN "save_digest" text;
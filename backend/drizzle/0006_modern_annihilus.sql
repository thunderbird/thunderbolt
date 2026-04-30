-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "user" ADD COLUMN "is_new" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "user" SET is_new = false;
-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

DROP INDEX "device_code_deviceCode_idx";--> statement-breakpoint
DROP INDEX "device_code_userCode_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_deviceCode_uidx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_userCode_uidx" ON "device_code" USING btree ("user_code");
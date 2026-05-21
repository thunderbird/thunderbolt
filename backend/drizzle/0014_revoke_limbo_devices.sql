-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- THU-502: Revoke pre-existing limbo device rows.
-- Before this migration, denyDevice() and cancelPending only cleared
-- approval_pending without setting revoked_at, leaving rows in
-- (trusted=false, approval_pending=false, revoked_at=NULL). These rows
-- count toward the device cap (countActiveDevices) and have no exit
-- transition, blocking new device registration. Backfill them as revoked.
UPDATE "powersync"."devices"
SET revoked_at = NOW(), trusted = false, approval_pending = false
WHERE trusted = false AND approval_pending = false AND revoked_at IS NULL;

-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- This column first shipped on its branch as 0031_breezy_shen, which collided with
-- main's 0031_e2ee_v2. It carries a current timestamp so drizzle's timestamp-ordered
-- runner applies it after 0031, and IF NOT EXISTS makes it a no-op on databases that
-- already ran the old 0031 (the PR preview, local dev).

ALTER TABLE "powersync"."chat_threads" ADD COLUMN IF NOT EXISTS "mini_app_id" text;

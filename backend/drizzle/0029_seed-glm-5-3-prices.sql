-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- QUOTA prices inherited from glm-5-2 (1500/5250) and deepseek-v4-flash (300/700).
-- Deliberately not Tinfoil's list prices (1800/5750 and 400/1250), so the per-token quota weight stays the same.
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'glm-5-3', 1500, 5250);
--> statement-breakpoint
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'glm-5-3-flash', 300, 700);

-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Charge confidential chat at Tinfoil's list prices, verified 2026-11-08 (nano-USD per token = USD per 1M tokens * 1000).
-- Catalog: https://inference.tinfoil.sh/v1/models (glm-5-3 1.80 in / 0.45 cached in / 5.75 out;
-- deepseek-v4-1-flash 0.60 in / 0.01 cached in / 1.45 out). These replace the quota weights seeded by 0029 and 0034.
-- Input and output change only where the seeded weight is still in place, so an operator's own price survives.
UPDATE "inference_prices" SET "input_nano_usd_per_token" = 1800, "output_nano_usd_per_token" = 5750, "updated_at" = now()
WHERE "provider" = 'tinfoil' AND "model" = 'glm-5-3' AND "input_nano_usd_per_token" = 1500 AND "output_nano_usd_per_token" = 5250;--> statement-breakpoint
UPDATE "inference_prices" SET "input_nano_usd_per_token" = 600, "output_nano_usd_per_token" = 1450, "updated_at" = now()
WHERE "provider" = 'tinfoil' AND "model" = 'deepseek-v4-1-flash' AND "input_nano_usd_per_token" = 300 AND "output_nano_usd_per_token" = 700;--> statement-breakpoint
UPDATE "inference_prices" SET "cache_read_nano_usd_per_token" = 450, "updated_at" = now()
WHERE "provider" = 'tinfoil' AND "model" = 'glm-5-3' AND "cache_read_nano_usd_per_token" IS NULL;--> statement-breakpoint
UPDATE "inference_prices" SET "cache_read_nano_usd_per_token" = 10, "updated_at" = now()
WHERE "provider" = 'tinfoil' AND "model" = 'deepseek-v4-1-flash' AND "cache_read_nano_usd_per_token" IS NULL;

-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Tinfoil list price, verified 2026-11-23: 4.00 in / 0.40 cached in / 20.00 out per 1M tokens (nano-USD per token = USD per 1M tokens * 1000).
-- Catalog: https://inference.tinfoil.sh/v1/models
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token", "cache_read_nano_usd_per_token")
VALUES ('tinfoil', 'kimi-k3-1-pro', 4000, 20000, 400)
ON CONFLICT ("provider", "model") DO NOTHING;

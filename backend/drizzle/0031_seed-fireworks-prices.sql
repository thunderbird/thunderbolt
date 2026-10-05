-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Fireworks serverless standard-tier list prices verified 2026-10-05 (nano-USD per token = USD per 1M tokens * 1000).
-- Cached-input discounts are not applied; only Anthropic cache pricing is modelled in the ledger.
-- Pricing: https://docs.fireworks.ai/serverless/pricing
-- https://fireworks.ai/models/fireworks/glm-5p3 (1.40 in / 4.40 out)
-- https://fireworks.ai/models/fireworks/minimax-m3 (0.30 in / 1.20 out)
-- The model column holds the id exactly as sent to the Fireworks API.
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('fireworks', 'accounts/fireworks/models/glm-5p3', 1400, 4400);
--> statement-breakpoint
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('fireworks', 'accounts/fireworks/models/minimax-m3', 300, 1200);

-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Official prices verified 2026-08-25.
-- Anthropic pricing and canonical model: https://platform.claude.com/docs/en/about-claude/pricing
-- https://platform.claude.com/docs/en/about-claude/models/overview
-- Tinfoil pricing and live canonical model catalog: https://tinfoil.sh/pricing
-- https://api.tinfoil.sh/api/config/models?paid=true
-- OpenAI-compatible Tinfoil chat model docs: https://docs.tinfoil.sh/sdk/javascript-sdk
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'deepseek-v4-flash', 300, 700);
--> statement-breakpoint
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('anthropic', 'claude-opus-5', 5000, 25000);
--> statement-breakpoint
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('tinfoil', 'glm-5-2', 1500, 5250);

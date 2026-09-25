-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- Official price verified 2026-09-24 (Claude Opus 5.5, released 2026-09-22):
-- $4/MTok input, $20/MTok output.
-- https://platform.claude.com/docs/en/about-claude/pricing
-- claude-opus-5 (5000/25000, seeded in 0028) stays in place: usage rows already
-- reference it, and `loadInferencePrice` resolves historical events by name.
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('anthropic', 'claude-opus-5-5', 4000, 20000);

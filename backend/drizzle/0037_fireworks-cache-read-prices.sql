-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "inference_prices" ADD COLUMN "cache_read_nano_usd_per_token" bigint;--> statement-breakpoint
ALTER TABLE "inference_prices" ADD CONSTRAINT "inference_prices_cache_read_nonnegative" CHECK ("inference_prices"."cache_read_nano_usd_per_token" >= 0);--> statement-breakpoint
-- Fireworks serverless standard-tier cached-input list prices verified 2026-10-14 (nano-USD per token = USD per 1M tokens * 1000).
-- Pricing: https://docs.fireworks.ai/serverless/pricing (GLM 5.3 standard 0.26, MiniMax M3 standard 0.06)
-- https://fireworks.ai/models/fireworks/glm-5p3 (1.40 in / 0.26 cached in / 4.40 out)
-- https://fireworks.ai/models/fireworks/minimax-m3 (0.30 in / 0.06 cached in / 1.20 out; its FAQ says 0.059, the pricing tables say 0.06)
-- Only the cache-read column is written, so an operator who changed the input or output rate keeps that change.
UPDATE "inference_prices" SET "cache_read_nano_usd_per_token" = 260, "updated_at" = now()
WHERE "provider" = 'fireworks' AND "model" = 'accounts/fireworks/models/glm-5p3';
--> statement-breakpoint
UPDATE "inference_prices" SET "cache_read_nano_usd_per_token" = 60, "updated_at" = now()
WHERE "provider" = 'fireworks' AND "model" = 'accounts/fireworks/models/minimax-m3';

-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- QUOTA price inherited from opus-5 (5000/25000), deliberately not the provider list price.
INSERT INTO "inference_prices" ("provider", "model", "input_nano_usd_per_token", "output_nano_usd_per_token")
VALUES ('anthropic', 'claude-opus-5-5', 5000, 25000)
ON CONFLICT ("provider", "model") DO NOTHING;

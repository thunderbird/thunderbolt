-- Seed default settings
-- These settings are inserted with ON CONFLICT DO NOTHING to avoid overwriting existing values
INSERT OR IGNORE INTO settings (key, value) VALUES
('cloud_url', 'https://api.thunderbolt.ai'),
('anonymous_id', '0198ecc5-cc2b-735b-b478-000000000001'),
('is_triggers_enabled', 'false'),
('disable_flower_encryption', 'false'),
('debug_posthog', 'false');
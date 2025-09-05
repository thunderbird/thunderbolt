-- Seed system models
-- Using hardwired IDs to ensure consistency across installs
INSERT OR IGNORE INTO models (id, name, provider, model, is_system, enabled, is_confidential, context_window, tool_usage) VALUES
('0198ecc5-cc2b-735b-b478-785b85d3c731', 'Qwen 3', 'flower', 'qwen/qwen3-235b', 1, 1, 1, 256000, 1);

-- Seed user models
INSERT OR IGNORE INTO models (id, name, provider, model, is_system, enabled, is_confidential, context_window) VALUES
('0198ecc5-cc2b-735b-b478-7c6770371b84', 'Qwen 3', 'thunderbolt', 'qwen3-235b-a22b-instruct-2507', 0, 1, 0, 256000),
('0198ecc5-cc2b-735b-b478-80dcfed4ea97', 'Qwen 3 (Thinking)', 'thunderbolt', 'qwen3-235b-a22b-thinking-2507', 0, 1, 0, 256000);

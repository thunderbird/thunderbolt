-- Seed default prompts
-- Using hardwired IDs to ensure consistency across installs
-- These prompts reference the system model seeded in 0004_seed-models.sql
INSERT OR IGNORE INTO prompts (id, title, prompt, model_id) VALUES
('0198ecc5-cc2b-735b-b478-9ff7f5b047d3', 'Daily Brief', 'Create a daily brief with weather, news, email summary, and calendar. Skip sections for which you lack information or tools.', '0198ecc5-cc2b-735b-b478-785b85d3c731'),
('0198ecc5-cc2b-735b-b478-a17c00778369', 'Deep Research', 'You are Deep Research, an expert analyst. Ask what topic to investigate, then systematically research using search and fetch tools.', '0198ecc5-cc2b-735b-b478-785b85d3c731'),
('0198ecc5-cc2b-735b-b478-a61c73ab50d6', 'Important Emails', 'Review my inbox and summarize the 5 most important emails that need my attention today. Include sender, subject, and why each is important.', '0198ecc5-cc2b-735b-b478-785b85d3c731');
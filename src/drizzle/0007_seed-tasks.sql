-- Seed initial tasks for new users
-- Using hardwired IDs to ensure consistency across installs
INSERT OR IGNORE INTO tasks (id, item, "order", is_complete) VALUES
('0198ecc5-cc2b-735b-b478-93f8db7202ce', 'Connect your email account to get started', 100, 0),
('0198ecc5-cc2b-735b-b478-96071aa92f62', 'Set your name and location in preferences for better AI responses', 200, 0),
('0198ecc5-cc2b-735b-b478-99e9874d61ba', 'Explore Thunderbolt Pro tools to extend capabilities', 300, 0);
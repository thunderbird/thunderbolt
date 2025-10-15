ALTER TABLE `chat_messages` ADD `parent_id` text REFERENCES chat_messages(id) ON DELETE CASCADE;--> statement-breakpoint

-- Set parent_id for existing messages based on chronological order within each thread
-- This creates a linear chain of messages within each thread
UPDATE chat_messages
SET parent_id = (
  SELECT id 
  FROM chat_messages AS prev_msg
  WHERE prev_msg.chat_thread_id = chat_messages.chat_thread_id
    AND prev_msg.id < chat_messages.id
  ORDER BY prev_msg.id DESC
  LIMIT 1
);
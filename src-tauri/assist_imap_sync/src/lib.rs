use anyhow::{Context, Result};
use assist_imap_client::ImapClient;
use chrono::{DateTime, TimeZone, Utc};
use libsql::Connection;
use mail_parser::Message;
use regex::Regex;
use serde_json;
use uuid::Uuid;

/// ImapSync provides functionality to synchronize IMAP messages with a local SQLite database
pub struct ImapSync {
    imap_client: ImapClient,
    db_conn: Connection,
}

impl ImapSync {
    /// Create a new ImapSync instance
    pub fn new(imap_client: ImapClient, db_conn: Connection) -> Self {
        Self {
            imap_client,
            db_conn,
        }
    }

    /// Save a message to the database
    pub async fn save_message(&self, message: &Message<'_>) -> Result<()> {
        // Generate a UUID v7
        let id = Uuid::now_v7().to_string();

        // Extract message_id
        let message_id =
            Self::extract_message_id(message).context("Failed to extract message ID")?;

        // Extract subject
        let subject = Self::extract_subject(message);

        // Extract message bodies
        let (html_body, text_body) = Self::extract_bodies(message);

        // Clean the text body by removing quoted text
        let cleaned_text_body = Self::clean_text(&text_body);

        // Convert message parts to JSON
        let parts_json =
            serde_json::to_string(&message).context("Failed to serialize message parts")?;

        // Extract date
        let date = Self::extract_date(message);

        // Extract from and in_reply_to
        let from = Self::extract_from(message).context("Failed to extract from field")?;
        let in_reply_to = Self::extract_in_reply_to(message);

        // Insert into database
        let query = r#"
            INSERT INTO email_messages (id, message_id, html_body, text_body, parts, subject, date, "from", in_reply_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (message_id) DO NOTHING
        "#;

        // Use proper libsql parameter types
        let params = vec![
            libsql::Value::Text(id),
            libsql::Value::Text(message_id),
            libsql::Value::Text(html_body),
            libsql::Value::Text(cleaned_text_body),
            libsql::Value::Text(parts_json),
            libsql::Value::Text(subject.unwrap_or_default()),
            libsql::Value::Text(date),
            libsql::Value::Text(from),
            if let Some(reply_to) = in_reply_to {
                libsql::Value::Text(reply_to)
            } else {
                libsql::Value::Null
            },
        ];

        let result = self.db_conn.execute(query, params).await;

        // If there's a unique constraint error, we just ignore it
        if let Err(e) = &result {
            if e.to_string().contains("UNIQUE constraint failed") {
                return Ok(());
            }
        }

        result.context("Failed to insert message into database")?;

        Ok(())
    }

    /// Sync messages from a specific mailbox
    pub async fn sync_messages(
        &self,
        mailbox: &str,
        start_index: usize,
        count: usize,
        since: Option<DateTime<Utc>>,
    ) -> Result<(usize, bool)> {
        println!("Syncing messages from {} (index {})", mailbox, start_index);

        // Fetch messages from mailbox
        let messages = self
            .imap_client
            .fetch_inbox(mailbox, Some(start_index), Some(count))
            .with_context(|| format!("Failed to fetch messages from {}", mailbox))?;

        println!("Retrieved {} messages", messages.len());

        // Filter out messages that are older than the since date
        let messages = if let Some(since_date) = since {
            messages
                .into_iter()
                .filter(|message| {
                    if let Some(message_date) = Self::parse_message_date(message) {
                        message_date >= since_date
                    } else {
                        true // Keep messages with no date
                    }
                })
                .collect::<Vec<_>>()
        } else {
            messages
        };

        println!("After filtering: {} messages to process", messages.len());

        // Check if we retrieved any messages
        let has_more_messages = messages.len() == count;
        let mut saved_count = 0;

        // Process each message
        for message in messages {
            // Save the message
            if let Err(e) = self.save_message(&message).await {
                // Log error but continue with other messages
                eprintln!("Error saving message: {}", e);
                continue;
            }

            saved_count += 1;
        }

        println!("Saved {} messages", saved_count);

        Ok((saved_count, has_more_messages))
    }

    /// Sync an entire mailbox with pagination
    pub async fn sync_mailbox(
        &self,
        mailbox: &str,
        page_size: usize,
        since: Option<DateTime<Utc>>,
    ) -> Result<usize> {
        let mut total_saved = 0;

        // Note that IMAP indexes start at 1
        let mut current_index = 1;

        loop {
            let (saved, has_more_messages) = self
                .sync_messages(mailbox, current_index, page_size, since)
                .await
                .with_context(|| {
                    format!(
                        "Failed to sync messages from {} (index {})",
                        mailbox, current_index
                    )
                })?;

            total_saved += saved;

            // If there are no more messages to fetch, we're done
            if !has_more_messages {
                break;
            }

            // Move to the next page
            current_index += page_size;
        }

        Ok(total_saved)
    }

    /// Remove quoted text from an email body
    pub fn clean_text(email_text: &str) -> String {
        let re =
            Regex::new(r"^([\s\S]*?)(?:From:|On\s+.*\s+wrote:|\n>)[\s\S]*$").unwrap_or_else(|_| {
                // If regex compilation fails, return a default regex that won't match anything
                Regex::new(r"^$").unwrap()
            });

        match re.captures(email_text) {
            Some(caps) => {
                if let Some(m) = caps.get(1) {
                    m.as_str().trim().to_string()
                } else {
                    email_text.to_string()
                }
            }
            None => email_text.to_string(),
        }
    }

    // Helper methods to extract data from messages

    fn extract_message_id(message: &Message<'_>) -> Result<String> {
        message
            .message_id()
            .map(|id| id.to_string())
            .ok_or_else(|| anyhow::anyhow!("Message ID not found"))
    }

    fn extract_subject(message: &Message<'_>) -> Option<String> {
        message.subject().map(|s| s.to_string())
    }

    fn extract_bodies(message: &Message<'_>) -> (String, String) {
        // Get HTML and text content
        let mut html_body = String::new();
        let mut text_body = String::new();

        // Process all body parts
        if let Some(bodies) = message.body_html(0) {
            html_body = bodies.to_string();
        }

        if let Some(bodies) = message.body_text(0) {
            text_body = bodies.to_string();
        }

        (html_body, text_body)
    }

    fn extract_date(message: &Message<'_>) -> String {
        message
            .date()
            .map(|d| d.to_rfc3339())
            .unwrap_or_else(|| Utc::now().to_rfc3339())
    }

    fn extract_from(message: &Message<'_>) -> Result<String> {
        if let Some(address) = message.from() {
            return Ok(format!("{:?}", address));
        }
        Err(anyhow::anyhow!("From field not found"))
    }

    fn extract_in_reply_to(message: &Message<'_>) -> Option<String> {
        // Get the in-reply-to header directly
        message
            .headers()
            .iter()
            .find(|header| header.name().eq_ignore_ascii_case("in-reply-to"))
            .map(|header| format!("{:?}", header.value()))
    }

    fn parse_message_date(message: &Message<'_>) -> Option<DateTime<Utc>> {
        message
            .date()
            .map(|d| {
                // Convert mail-parser::DateTime to chrono::DateTime
                let year = d.year as i32;
                let month = d.month as u32;
                let day = d.day as u32;
                let hour = d.hour as u32;
                let minute = d.minute as u32;
                let second = d.second as u32;

                Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
                    .single()
            })
            .flatten()
    }
}

use anyhow::Result;
use chrono::{TimeZone, Utc};
use imap::{self, ImapConnection, Session};
use mail_parser::MessageParser;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Type alias for the IMAP session type to reduce complexity
type ImapSession = Arc<Mutex<Option<Session<Box<dyn ImapConnection>>>>>;

/// Credentials for connecting to an IMAP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapCredentials {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// Options for configuring IMAP client behavior
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImapOptions {
    pub debug: Option<bool>,
}

/// Email address structure with name and address fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: String,
}

/// Structure representing an email message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailMessage {
    pub imap_id: String,
    pub html_body: String,
    pub text_body: String,
    pub clean_text: String,
    pub subject: Option<String>,
    pub sent_at: i64,
    pub from_address: EmailAddress,
    pub to_addresses: Vec<EmailAddress>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}

/// Structure representing the response from fetch_messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchMessagesResponse {
    pub index: usize,
    pub total: usize,
    pub messages: Vec<EmailMessage>,
}

/// ImapClient provides an object-oriented interface to IMAP operations
pub struct ImapClient {
    credentials: ImapCredentials,
    options: ImapOptions,
    session: ImapSession,
}

impl ImapClient {
    /// Create a new ImapClient with the given credentials
    pub fn new(credentials: ImapCredentials) -> Self {
        ImapClient {
            credentials,
            options: ImapOptions::default(),
            session: Arc::new(Mutex::new(None)),
        }
    }

    /// Create a new ImapClient with the given credentials and options
    pub fn new_with_options(credentials: ImapCredentials, options: ImapOptions) -> Self {
        ImapClient {
            credentials,
            options,
            session: Arc::new(Mutex::new(None)),
        }
    }

    /// Connect to the IMAP server
    pub fn connect(&self) -> Result<()> {
        let mut session_guard = self.session.lock().unwrap();

        // If already connected, do nothing
        if session_guard.is_some() {
            return Ok(());
        }

        let client = imap::ClientBuilder::new(&self.credentials.hostname, self.credentials.port)
            .danger_skip_tls_verify(true)
            .connect()?;

        let mut imap_session = client
            .login(&self.credentials.username, &self.credentials.password)
            .map_err(|e| anyhow::anyhow!(e.0))?;

        // Set debug mode based on options
        if let Some(debug) = self.options.debug {
            imap_session.debug = debug;
        } else {
            imap_session.debug = false;
        }

        *session_guard = Some(imap_session);

        Ok(())
    }

    /// Disconnect from the IMAP server
    pub fn disconnect(&self) -> Result<()> {
        let mut session_guard = self.session.lock().unwrap();

        if let Some(mut session) = session_guard.take() {
            session.logout()?;
        }

        Ok(())
    }

    /// List all available mailboxes and their message counts
    pub fn list_mailboxes(&self) -> Result<HashMap<String, u32>> {
        self.connect()?;

        let mut result = HashMap::new();
        let mut session_guard = self.session.lock().unwrap();

        if let Some(ref mut session) = *session_guard {
            let mailboxes = session.list(Some(""), Some("*"))?;

            for mailbox in mailboxes.iter() {
                if let Ok(status) = session.status(mailbox.name(), "(MESSAGES)") {
                    let count = status.exists;
                    result.insert(mailbox.name().to_string(), count);
                }
            }
        }

        Ok(result)
    }

    pub fn fetch_messages(
        &self,
        mailbox: &str,
        start_index: Option<usize>,
        count: Option<usize>,
    ) -> Result<FetchMessagesResponse> {
        self.connect()?;

        let mut session_guard = self.session.lock().unwrap();
        let mut messages = Vec::new();
        let mut total_messages = 0;
        let mut actual_start_index = 0;

        if let Some(ref mut session) = *session_guard {
            // The SELECT command returns mailbox information including message count
            // We can get the total messages directly from this response
            let mailbox_data = session.select(mailbox)?;
            total_messages = mailbox_data.exists as usize;

            // If mailbox is empty, return empty result
            if total_messages == 0 {
                // Return a properly structured empty result
                return Ok(FetchMessagesResponse {
                    index: 0,
                    total: 0,
                    messages: vec![],
                });
            }

            // Calculate the range to fetch
            let requested_count = count.unwrap_or(10);
            let start = start_index.unwrap_or_else(|| {
                if requested_count >= total_messages {
                    1
                } else {
                    total_messages - requested_count + 1
                }
            });
            actual_start_index = start;

            // Ensure start is valid (not beyond total)
            let start = std::cmp::min(start, total_messages);

            // Calculate end index
            let end = std::cmp::min(start + requested_count - 1, total_messages);

            // Create the fetch range
            let fetch_range = format!("{start}:{end}");

            let message_set = session.fetch(&fetch_range, "RFC822")?;

            for message in message_set.iter() {
                let body = message.body().expect("message did not have a body!");
                let body = std::str::from_utf8(body)
                    .expect("message was not valid utf-8")
                    .to_string();

                let parsed_message = MessageParser::default().parse(body.as_bytes()).unwrap();

                // Extract message ID
                let imap_id = parsed_message
                    .message_id()
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                // Extract HTML body
                let html_body = parsed_message
                    .body_html(0)
                    .map(|body| body.to_string())
                    .unwrap_or_default();

                // Extract text body
                let text_body = parsed_message
                    .body_text(0)
                    .map(|body| body.to_string())
                    .unwrap_or_default();

                // Extract cleaned text body
                let clean_text = remove_urls(&text_body);

                // Extract subject
                let subject = parsed_message.subject().map(|s| s.to_string());

                // Extract sent_at timestamp
                let sent_at = parsed_message
                    .date()
                    .and_then(|d| {
                        // Convert mail-parser::DateTime to chrono::DateTime
                        let year = d.year as i32;
                        let month = d.month as u32;
                        let day = d.day as u32;
                        let hour = d.hour as u32;
                        let minute = d.minute as u32;
                        let second = d.second as u32;

                        Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
                            .single()
                            .map(|dt| dt.timestamp())
                    })
                    .unwrap_or_else(|| Utc::now().timestamp());

                // Extract from address
                let from_address = parsed_message
                    .from()
                    .and_then(|addresses| addresses.first())
                    .map(|addr| EmailAddress {
                        name: addr.name().map(|name| name.to_string()),
                        address: addr
                            .address()
                            .map(|addr| addr.to_string())
                            .unwrap_or_default(),
                    })
                    .unwrap_or(EmailAddress {
                        name: None,
                        address: String::new(),
                    });

                // Extract to addresses
                let to_addresses = parsed_message
                    .to()
                    .map(|addresses| {
                        addresses
                            .iter()
                            .map(|addr| EmailAddress {
                                name: addr.name().map(|name| name.to_string()),
                                address: addr
                                    .address()
                                    .map(|addr| addr.to_string())
                                    .unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_else(Vec::new);

                // Extract in_reply_to
                let in_reply_to = parsed_message
                    .in_reply_to()
                    .as_text()
                    .map(|s| s.to_string());

                // Extract references as a list of message IDs
                let references = parsed_message
                    .references()
                    .as_text_list()
                    .map(|list| list.iter().map(|s| s.to_string()).collect())
                    .unwrap_or_else(Vec::new);

                // Create the message object using our struct
                let email_message = EmailMessage {
                    imap_id,
                    html_body,
                    text_body,
                    clean_text,
                    subject,
                    sent_at,
                    from_address,
                    to_addresses,
                    in_reply_to,
                    references,
                };

                messages.push(email_message);
            }
        }

        // Create the result object
        let result = FetchMessagesResponse {
            index: actual_start_index,
            total: total_messages,
            messages,
        };

        // Return the struct directly
        Ok(result)
    }

    /// Fetch messages from a specific mailbox
    pub fn fetch_inbox(
        &self,
        mailbox: &str,
        start_index: Option<usize>,
        count: Option<usize>,
    ) -> Result<Vec<mail_parser::Message<'_>>> {
        self.connect()?;

        let mut session_guard = self.session.lock().unwrap();
        let mut result = Vec::new();

        if let Some(ref mut session) = *session_guard {
            session.select(mailbox)?;

            // Get the total number of messages in the mailbox
            let status = session.status(mailbox, "(MESSAGES)")?;
            let total_messages = status.exists as usize;

            // If mailbox is empty, return empty result
            if total_messages == 0 {
                return Ok(Vec::new());
            }

            // Calculate the range to fetch
            let requested_count = count.unwrap_or(10);
            let start = start_index.unwrap_or_else(|| {
                if requested_count >= total_messages {
                    1
                } else {
                    total_messages - requested_count + 1
                }
            });

            // Ensure start is valid (not beyond total)
            let start = std::cmp::min(start, total_messages);

            // Calculate end index
            let end = std::cmp::min(start + requested_count - 1, total_messages);

            // Create the fetch range
            let fetch_range = format!("{start}:{end}");

            let messages = session.fetch(&fetch_range, "RFC822")?;

            for message in messages.iter() {
                let body = message.body().expect("message did not have a body!");
                let body = std::str::from_utf8(body)
                    .expect("message was not valid utf-8")
                    .to_string();

                let parsed_message = MessageParser::default().parse(body.as_bytes()).unwrap();
                result.push(parsed_message.into_owned());
            }
        }

        Ok(result)
    }

    /// Fetch messages from all available mailboxes
    pub fn fetch_all_mailboxes(
        &self,
        count_per_mailbox: Option<usize>,
    ) -> Result<Vec<mail_parser::Message<'_>>> {
        self.connect()?;

        let mut session_guard = self.session.lock().unwrap();
        let mut all_messages = Vec::new();

        if let Some(ref mut session) = *session_guard {
            // List all mailboxes
            let mailboxes = session.list(Some(""), Some("*"))?;

            // Iterate through each mailbox
            for mailbox in mailboxes.iter() {
                let mailbox_name = mailbox.name().to_string();

                // Try to select the mailbox
                match session.select(&mailbox_name) {
                    Ok(_) => {
                        // Get the total number of messages in this mailbox
                        if let Ok(status) = session.status(&mailbox_name, "(MESSAGES)") {
                            let total_messages = status.exists as usize;

                            if total_messages > 0 {
                                // Calculate how many messages to fetch
                                let requested_count = count_per_mailbox.unwrap_or(10);
                                let actual_count = std::cmp::min(requested_count, total_messages);

                                // Create the fetch range
                                let fetch_range = if actual_count == total_messages {
                                    format!("1:{total_messages}")
                                } else {
                                    // Get the most recent messages
                                    format!(
                                        "{}:{total_messages}",
                                        total_messages - actual_count + 1
                                    )
                                };

                                // Fetch messages from this mailbox
                                if let Ok(messages) = session.fetch(&fetch_range, "RFC822") {
                                    for message in messages.iter() {
                                        if let Some(body) = message.body() {
                                            if let Ok(body_str) = std::str::from_utf8(body) {
                                                if let Some(parsed_message) =
                                                    MessageParser::default()
                                                        .parse(body_str.as_bytes())
                                                {
                                                    all_messages.push(parsed_message.into_owned());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // Log error but continue with other mailboxes
                        eprintln!("Could not select mailbox {mailbox_name}: {e}");
                    }
                }
            }
        }

        Ok(all_messages)
    }
}

/// Utility functions for working with messages
/// Removes URLs from a string
pub fn remove_urls(input: &str) -> String {
    let url_regex = Regex::new(r"https?://[^\s]+|www\.[^\s]+").unwrap();
    let cleaned = url_regex.replace_all(input, "");
    let whitespace_regex = Regex::new(r"\s+").unwrap();
    whitespace_regex.replace_all(&cleaned, " ").to_string()
}

/// Converts a mail_parser::Message to a serde_json::Value with proper body content
pub fn message_to_json_value(message: &mail_parser::Message) -> Result<serde_json::Value> {
    let mut message_json = serde_json::to_value(message)?;

    if let Some(obj) = message_json.as_object_mut() {
        // Handle HTML body parts
        if obj.contains_key("html_body") {
            // Remove the original html_body array
            obj.remove("html_body");

            // Create a new array to store all HTML body parts as strings
            let mut html_bodies = Vec::new();

            // Try to get each HTML body part
            let mut index = 0;
            while let Some(html_body) = message.body_html(index) {
                html_bodies.push(serde_json::Value::String(html_body.to_string()));
                index += 1;
            }

            // If we found any HTML body parts
            if !html_bodies.is_empty() {
                if html_bodies.len() == 1 {
                    // If there's only one part, store it directly as a string
                    obj.insert("html_body".to_string(), html_bodies[0].clone());
                } else {
                    // If there are multiple parts, store them as an array
                    obj.insert(
                        "html_body".to_string(),
                        serde_json::Value::Array(html_bodies),
                    );
                }
            }
        }

        // Handle text body parts
        if obj.contains_key("text_body") {
            // Remove the original text_body array
            obj.remove("text_body");

            // Create a new array to store all text body parts as strings
            let mut text_bodies = Vec::new();

            // Try to get each text body part
            let mut index = 0;
            while let Some(text_body) = message.body_text(index) {
                text_bodies.push(serde_json::Value::String(text_body.to_string()));
                index += 1;
            }

            // If we found any text body parts
            if !text_bodies.is_empty() {
                if text_bodies.len() == 1 {
                    // If there's only one part, store it directly as a string
                    obj.insert("text_body".to_string(), text_bodies[0].clone());
                } else {
                    // If there are multiple parts, store them as an array
                    obj.insert(
                        "text_body".to_string(),
                        serde_json::Value::Array(text_bodies),
                    );
                }
            }
        }

        // Add a clean_text field that removes URLs from the text body
        if let Some(text_body) = message.body_text(0) {
            let clean_text = remove_urls(&text_body);
            obj.insert(
                "clean_text".to_string(),
                serde_json::Value::String(clean_text),
            );
        }
    }

    Ok(message_json)
}

/// Converts a vector of mail_parser::Message to a vector of serde_json::Value
pub fn messages_to_json_values(
    messages: &[mail_parser::Message],
) -> Result<Vec<serde_json::Value>> {
    let mut result = Vec::with_capacity(messages.len());

    for message in messages {
        match message_to_json_value(message) {
            Ok(json_value) => result.push(json_value),
            Err(err) => {
                // Log the error but continue processing other messages
                eprintln!("Error converting message to JSON: {err}");
                // Add a null value as a placeholder for the failed message
                result.push(serde_json::Value::Null);
            }
        }
    }

    Ok(result)
}

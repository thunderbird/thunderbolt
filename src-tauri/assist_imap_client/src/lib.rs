use anyhow::Result;
use imap::{self, ImapConnection, Session};
use mail_parser::MessageParser;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Credentials for connecting to an IMAP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapCredentials {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// Options for configuring IMAP client behavior
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapOptions {
    pub debug: Option<bool>,
}

impl Default for ImapOptions {
    fn default() -> Self {
        ImapOptions { debug: None }
    }
}

/// ImapClient provides an object-oriented interface to IMAP operations
pub struct ImapClient {
    credentials: ImapCredentials,
    options: ImapOptions,
    session: Arc<Mutex<Option<Session<Box<dyn ImapConnection>>>>>,
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

    /// Fetch messages from a specific mailbox
    pub fn fetch_inbox(
        &self,
        mailbox: &str,
        start_index: Option<usize>,
        count: Option<usize>,
    ) -> Result<Vec<mail_parser::Message>> {
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
            let fetch_range = format!("{}:{}", start, end);

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
    ) -> Result<Vec<mail_parser::Message>> {
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
                                    format!("1:{}", total_messages)
                                } else {
                                    // Get the most recent messages
                                    format!(
                                        "{}:{}",
                                        total_messages - actual_count + 1,
                                        total_messages
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
                        eprintln!("Could not select mailbox {}: {}", mailbox_name, e);
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
                eprintln!("Error converting message to JSON: {}", err);
                // Add a null value as a placeholder for the failed message
                result.push(serde_json::Value::Null);
            }
        }
    }

    Ok(result)
}

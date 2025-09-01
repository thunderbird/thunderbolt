use dotenv::dotenv;
use std::env;
use thunderbolt_imap_client::{messages_to_json_values, ImapClient, ImapCredentials, ImapOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Try to load from .env if present
    if let Ok(path) = env::var("CARGO_MANIFEST_DIR") {
        let env_path = std::path::Path::new(&path).join(".env");
        if env_path.exists() {
            dotenv::from_path(env_path).ok();
        } else {
            dotenv().ok();
        }
    } else {
        dotenv().ok();
    }

    // Get credentials from environment variables
    let hostname = env::var("IMAP_DOMAIN").expect("IMAP_DOMAIN environment variable must be set");
    let username =
        env::var("IMAP_USERNAME").expect("IMAP_USERNAME environment variable must be set");
    let password =
        env::var("IMAP_PASSWORD").expect("IMAP_PASSWORD environment variable must be set");
    let port = env::var("IMAP_PORT")
        .expect("IMAP_PORT environment variable must be set")
        .parse::<u16>()
        .expect("IMAP_PORT must be a valid port number");

    // Create credentials
    let credentials = ImapCredentials {
        hostname,
        port,
        username,
        password,
    };

    let options = ImapOptions { debug: Some(false) };

    // Create client
    let client = ImapClient::new_with_options(credentials, options);

    // List mailboxes
    println!("Listing mailboxes...");
    let mailboxes = client.list_mailboxes()?;
    for (name, count) in mailboxes.iter() {
        println!("Mailbox: {} - {} messages", name, count);
    }

    // Fetch inbox messages
    println!("\nFetching inbox messages...");
    let messages = client.fetch_inbox("INBOX", None, Some(5))?;
    println!("Fetched {} messages from inbox", messages.len());

    // Convert messages to JSON
    let json_messages = messages_to_json_values(&messages)?;

    // Print subject of each message
    for (i, message) in json_messages.iter().enumerate() {
        if let Some(subject) = message.get("subject") {
            println!("Message {}: Subject: {}", i + 1, subject);
        } else {
            println!("Message {}: No subject", i + 1);
        }
    }

    // Disconnect
    client.disconnect()?;
    println!("\nDisconnected from IMAP server");

    Ok(())
}

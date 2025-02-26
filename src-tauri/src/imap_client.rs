use std::env;

use html2text::from_read;
use mailparse::MailHeaderMap;

use anyhow::Result;
use chrono::Utc;
use entity::message;
use sea_orm::ActiveModelBehavior;
use sea_orm::ActiveValue::Set;

pub fn parse_email_to_message(mail_body: &str, id: Option<i32>) -> Result<message::ActiveModel> {
    // Parse the email
    let parsed_mail = mailparse::parse_mail(mail_body.as_bytes())?;

    // Extract subject (with fallback to empty string if not found)
    let subject = parsed_mail
        .headers
        .get_first_value("Subject")
        .unwrap_or_else(|| String::from(""));

    // Extract date (with fallback to current time if not found or parsing fails)
    let date = parsed_mail
        .headers
        .get_first_value("Date")
        .and_then(|date_str| mailparse::dateparse(&date_str).ok())
        .map(|timestamp| {
            chrono::DateTime::from_timestamp(timestamp, 0).unwrap_or_else(|| Utc::now())
        })
        .unwrap_or_else(|| Utc::now());

    // Get body content
    let body = parsed_mail.get_body()?;

    // Create a snippet (first 100 chars of body)
    let snippet = body.chars().take(100).collect::<String>();

    // Extract clean text based on content type
    let clean_text = if parsed_mail.ctype.mimetype.starts_with("text/html") {
        // Convert HTML to plain text
        from_read(body.as_bytes(), 80)?
    } else {
        // Already plain text
        body.clone()
    };

    // Create the message model
    let mut message = message::ActiveModel::new();
    message.date = Set(date);
    message.subject = Set(subject);
    message.body = Set(body);
    message.snippet = Set(snippet);
    message.clean_text = Set(clean_text);
    message.clean_text_tokens_in = Set(0); // Placeholder for token count
    message.clean_text_tokens_out = Set(0); // Placeholder for token count

    Ok(message)
}

fn dump(pfx: &str, pm: &mailparse::ParsedMail) {
    println!(">> Headers from {} <<", pfx);
    for h in &pm.headers {
        println!("  [{}] => [{}]", h.get_key(), h.get_value());
    }
    println!(">> Addresses from {} <<", pfx);
    pm.headers
        .get_first_value("From")
        .map(|a| println!("{:?}", mailparse::addrparse(&a).unwrap()));
    pm.headers
        .get_first_value("To")
        .map(|a| println!("{:?}", mailparse::addrparse(&a).unwrap()));
    pm.headers
        .get_first_value("Cc")
        .map(|a| println!("{:?}", mailparse::addrparse(&a).unwrap()));
    pm.headers
        .get_first_value("Bcc")
        .map(|a| println!("{:?}", mailparse::addrparse(&a).unwrap()));
    println!(">> Body from {} <<", pfx);
    if pm.ctype.mimetype.starts_with("text/") {
        println!("  [{}]", pm.get_body().unwrap());
    } else {
        println!(
            "   (Body is binary type {}, {} bytes in length)",
            pm.ctype.mimetype,
            pm.get_body().unwrap().len()
        );
    }
    let mut c = 1;
    for s in &pm.subparts {
        println!(">> Subpart {} <<", c);
        dump("subpart", s);
        c += 1;
    }
}

pub fn fetch_inbox_top() -> imap::error::Result<Option<String>> {
    // Try to load from .env if present, continue if not found
    if let Ok(path) = env::var("CARGO_MANIFEST_DIR") {
        let env_path = std::path::Path::new(&path).join(".env");
        if env_path.exists() {
            dotenv::from_path(env_path).ok();
        }
    }

    let domain = env::var("IMAP_DOMAIN").expect("IMAP_DOMAIN environment variable must be set");
    let username =
        env::var("IMAP_USERNAME").expect("IMAP_USERNAME environment variable must be set");
    let password =
        env::var("IMAP_PASSWORD").expect("IMAP_PASSWORD environment variable must be set");
    let port = env::var("IMAP_PORT")
        .expect("IMAP_PORT environment variable must be set")
        .parse::<u16>()
        .expect("IMAP_PORT must be a valid port number");

    let client = imap::ClientBuilder::new(&domain, port)
        // .mode(imap::ConnectionMode::Tls)
        .danger_skip_tls_verify(true)
        .connect()?;

    let mut imap_session = client.login(&username, &password).map_err(|e| e.0)?;

    imap_session.debug = true;
    imap_session.select("INBOX")?;

    let messages = imap_session.fetch("1", "RFC822")?;
    let message = if let Some(m) = messages.iter().next() {
        m
    } else {
        return Ok(None);
    };

    // extract the message's body
    let body = message.body().expect("message did not have a body!");
    let body = std::str::from_utf8(body)
        .expect("message was not valid utf-8")
        .to_string();

    let mail = mailparse::parse_mail(body.as_bytes()).unwrap();
    dump("message", &mail);

    // be nice to the server and log out
    imap_session.logout()?;

    Ok(Some(body))
}

pub fn listen_for_emails() -> imap::error::Result<()> {
    // Try to load from .env if present, continue if not found
    if let Ok(path) = env::var("CARGO_MANIFEST_DIR") {
        let env_path = std::path::Path::new(&path).join(".env");
        if env_path.exists() {
            dotenv::from_path(env_path).ok();
        }
    }

    let domain = env::var("IMAP_DOMAIN").expect("IMAP_DOMAIN environment variable must be set");
    let username =
        env::var("IMAP_USERNAME").expect("IMAP_USERNAME environment variable must be set");
    let password =
        env::var("IMAP_PASSWORD").expect("IMAP_PASSWORD environment variable must be set");
    let port = env::var("IMAP_PORT")
        .expect("IMAP_PORT environment variable must be set")
        .parse::<u16>()
        .expect("IMAP_PORT must be a valid port number");

    let client = imap::ClientBuilder::new(&domain, port)
        // .mode(imap::ConnectionMode::Tls)
        .danger_skip_tls_verify(true)
        .connect()?;

    let mut imap_session = client.login(&username, &password).map_err(|e| e.0)?;

    imap_session.debug = true;

    imap_session
        .select("INBOX")
        .expect("Could not select mailbox");

    let mut num_responses = 0;
    let max_responses = 5;
    let idle_result = imap_session.idle().wait_while(|response| {
        num_responses += 1;
        println!("IDLE response #{}: {:?}", num_responses, response);

        if let imap::types::UnsolicitedResponse::Recent(uid) = response {
            println!("Recent uid: {:?}", uid);
        }

        if num_responses >= max_responses {
            // Stop IDLE
            false
        } else {
            // Continue IDLE
            true
        }
    });

    match idle_result {
        Ok(reason) => println!("IDLE finished normally {:?}", reason),
        Err(e) => println!("IDLE finished with error {:?}", e),
    }

    imap_session.logout().expect("Could not log out");

    Ok(())
}

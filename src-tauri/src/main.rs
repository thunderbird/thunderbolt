// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod embedding;
mod imap_client;

use anyhow::Result;
use sea_orm::ActiveModelTrait;
use sea_orm::ActiveValue::Set;

use entity::*;

#[tokio::main]
async fn main() -> Result<()> {
    // Handle the Result and Option types
    match imap_client::fetch_inbox_top() {
        Ok(Some(body)) => println!("{}", body),
        Ok(None) => println!("No message found"),
        Err(e) => eprintln!("Error: {}", e),
    }

    let db = db::init_db().await?;

    let message = message::ActiveModel {
        id: Set(1),
        date: Set(chrono::Utc::now()),
        subject: Set("Test Subject".to_owned()),
        body: Set("This is the message body".to_owned()),
        snippet: Set("This is the snippet".to_owned()),
        clean_text: Set("This is the clean text".to_owned()),
        clean_text_tokens_in: Set(0),
        clean_text_tokens_out: Set(0),
    };

    let inserted_message: message::Model = message.insert(&db).await?;

    mozilla_assist_lib::run();

    Ok(())
}

use mozilla_assist_lib::imap_client;

fn main() {
    // Handle the Result and Option types
    match imap_client::fetch_inbox_top() {
        Ok(Some(body)) => println!("{}", body),
        Ok(None) => println!("No message found"),
        Err(e) => eprintln!("Error: {}", e),
    }
}

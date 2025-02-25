use mozilla_assist_lib::db;

#[tokio::main]
async fn main() {
    // Handle the Result and Option types
    match db::init_db().await {
        Ok(_db) => println!("Database initialized"),
        Err(e) => eprintln!("Error: {}", e),
    }
}

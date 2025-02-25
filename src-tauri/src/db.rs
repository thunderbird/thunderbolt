use sea_orm::*;

pub async fn init_db() -> Result<DatabaseConnection, DbErr> {
    let db: DatabaseConnection = Database::connect("sqlite://data/local.db?mode=rwc").await?;
    Ok(db)
}

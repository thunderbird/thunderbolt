use migration::{Migrator, MigratorTrait};
use sea_orm::*;

pub async fn init_db() -> Result<DatabaseConnection, DbErr> {
    let conn: DatabaseConnection = Database::connect("sqlite://data/local.db?mode=rwc")
        .await
        .unwrap();

    Migrator::up(&conn, None).await.unwrap();

    Ok(conn)
}

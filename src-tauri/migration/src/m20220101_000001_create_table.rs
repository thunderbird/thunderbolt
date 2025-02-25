use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Message::Table)
                    .if_not_exists()
                    .col(pk_auto(Message::Id))
                    .col(timestamp(Message::Date))
                    .col(string(Message::Subject))
                    .col(text(Message::Body))
                    .col(string(Message::Snippet))
                    .col(text(Message::CleanText))
                    .col(integer(Message::CleanTextTokensIn))
                    .col(integer(Message::CleanTextTokensOut))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("Message_pkey")
                    .table(Message::Table)
                    .col(Message::Id)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(Index::drop().name("Message_pkey").to_owned())
            .await?;

        manager
            .drop_table(Table::drop().table(Message::Table).to_owned())
            .await
    }
}

/// Represents the "Message" table
#[derive(DeriveIden)]
enum Message {
    Table,
    Id,
    Date,
    Subject,
    Body,
    Snippet,
    CleanText,
    CleanTextTokensIn,
    CleanTextTokensOut,
}

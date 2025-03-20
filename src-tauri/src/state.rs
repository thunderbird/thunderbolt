use crate::db_pool::DbPool;
use assist_embeddings::embedding::Embedder;
use assist_imap_client::ImapClient;
use assist_imap_sync::ImapSync;

#[derive(Default)]
pub struct AppState {
    pub db_pool: Option<DbPool>,
    pub imap_client: Option<ImapClient>,
    pub imap_sync: Option<ImapSync>,
    pub embedder: Option<Embedder>,
}

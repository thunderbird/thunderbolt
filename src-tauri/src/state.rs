use crate::db_pool::DbPool;
use thunderbolt_embeddings::embedding::Embedder;
use thunderbolt_imap_client::ImapClient;
use thunderbolt_imap_sync::ImapSync;
use thunderbolt_bridge::BridgeServer;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    pub db_pool: Option<DbPool>,
    pub imap_client: Option<ImapClient>,
    pub imap_sync: Option<ImapSync>,
    pub embedder: Option<Arc<Embedder>>,
    pub bridge_server: Option<Arc<Mutex<BridgeServer>>>,
}

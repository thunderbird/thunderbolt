#[cfg(feature = "bridge")]
use thunderbolt_bridge::BridgeServer;
#[cfg(feature = "bridge")]
use std::sync::Arc;
#[cfg(feature = "bridge")]
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    #[cfg(feature = "bridge")]
    pub bridge_server: Option<Arc<Mutex<BridgeServer>>>,
}

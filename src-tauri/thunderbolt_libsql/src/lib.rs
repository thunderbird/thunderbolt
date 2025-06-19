use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use libsql::Value;
use serde_json::Value as JsonValue;
use tauri::{command, State};
use tokio::sync::Mutex;

pub mod db_pool;
pub use db_pool::DbPool;

/// Application state for the libsql functionality
pub struct LibsqlState {
    pub db_pool: Option<DbPool>,
}

impl LibsqlState {
    pub fn new() -> Self {
        Self { db_pool: None }
    }
}

/// Replace bind_values with this function to create params
pub fn create_params(values: &[JsonValue]) -> Result<Vec<libsql::Value>> {
    let mut params = Vec::with_capacity(values.len());

    for value in values {
        if value.is_null() {
            params.push(Value::Null);
        } else if let Some(s) = value.as_str() {
            params.push(Value::Text(s.to_string()));
        } else if let Some(n) = value.as_i64() {
            params.push(Value::Integer(n));
        } else if let Some(n) = value.as_f64() {
            params.push(Value::Real(n));
        } else if let Some(b) = value.as_bool() {
            params.push(Value::Integer(if b { 1 } else { 0 }));
        } else {
            // For complex types, serialize to JSON string
            params.push(Value::Text(value.to_string()));
        }
    }

    Ok(params)
}

pub fn value_to_json(value: Value) -> JsonValue {
    match value {
        Value::Null => JsonValue::Null,
        Value::Integer(i) => JsonValue::Number(i.into()),
        Value::Real(f) => {
            if let Some(n) = serde_json::Number::from_f64(f) {
                JsonValue::Number(n)
            } else {
                JsonValue::Null
            }
        }
        Value::Text(s) => JsonValue::String(s),
        Value::Blob(b) => {
            // Convert blob to base64 string
            let base64 = STANDARD.encode(&b);
            JsonValue::String(base64)
        }
    }
}

// Command implementations are placed in a sub-module to avoid macro namespace clashes at the crate root (see https://github.com/tauri-apps/tauri/issues/8577)
pub mod commands {
    use super::*;

    #[command]
    pub async fn init_libsql(
        state: State<'_, Mutex<LibsqlState>>,
        path: String,
        encryption_key: Option<String>,
        pool_size: Option<u32>,
    ) -> Result<String, String> {
        let pool_size = pool_size.unwrap_or(4) as usize;

        let db_pool = db_pool::DbPool::new(&path, encryption_key, pool_size)
            .await
            .map_err(|e| format!("Failed to build database pool: {e}"))?;

        let mut state = state.lock().await;
        state.db_pool = Some(db_pool);

        // Return the canonicalized path back to the caller so the JS side can
        // cache it and pass it on subsequent requests.
        Ok(path)
    }

    #[command]
    pub async fn execute(
        state: State<'_, Mutex<LibsqlState>>,
        _db: String,
        query: String,
        values: Option<Vec<serde_json::Value>>,
    ) -> Result<(u64, u64), String> {
        let state = state.lock().await;
        let pool = state.db_pool.as_ref().ok_or("Database not initialized")?;

        let connection_arc = pool.get_connection().await;
        let connection = connection_arc.lock().await;
        let mut stmt = connection.prepare(&query).await.map_err(|e| e.to_string())?;

        let rows_affected_usize: usize = if let Some(params) = values {
            let libsql_params: Vec<libsql::Value> = params
                .into_iter()
                .map(|p| match p {
                    serde_json::Value::String(s) => libsql::Value::Text(s),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            libsql::Value::Integer(i)
                        } else if let Some(f) = n.as_f64() {
                            libsql::Value::Real(f)
                        } else {
                            libsql::Value::Text(n.to_string())
                        }
                    }
                    serde_json::Value::Bool(b) => libsql::Value::Integer(if b { 1 } else { 0 }),
                    serde_json::Value::Null => libsql::Value::Null,
                    _ => libsql::Value::Text(p.to_string()),
                })
                .collect();

            stmt.execute(libsql_params).await.map_err(|e| e.to_string())?
        } else {
            stmt.execute(()).await.map_err(|e| e.to_string())?
        };

        let rows_affected = rows_affected_usize as u64;
        let last_insert_id = connection.last_insert_rowid() as u64;

        Ok((rows_affected, last_insert_id))
    }

    #[command]
    pub async fn select(
        state: State<'_, Mutex<LibsqlState>>,
        _db: String,
        query: String,
        values: Option<Vec<serde_json::Value>>,
    ) -> Result<Vec<Vec<serde_json::Value>>, String> {
        let state = state.lock().await;
        let pool = state.db_pool.as_ref().ok_or("Database not initialized")?;

        let connection_arc = pool.get_connection().await;
        let connection = connection_arc.lock().await;
        let mut stmt = connection.prepare(&query).await.map_err(|e| e.to_string())?;

        let rows = if let Some(params) = values {
            let libsql_params: Vec<libsql::Value> = params
                .into_iter()
                .map(|p| match p {
                    serde_json::Value::String(s) => libsql::Value::Text(s),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            libsql::Value::Integer(i)
                        } else if let Some(f) = n.as_f64() {
                            libsql::Value::Real(f)
                        } else {
                            libsql::Value::Text(n.to_string())
                        }
                    }
                    serde_json::Value::Bool(b) => libsql::Value::Integer(if b { 1 } else { 0 }),
                    serde_json::Value::Null => libsql::Value::Null,
                    _ => libsql::Value::Text(p.to_string()),
                })
                .collect();

            stmt.query(libsql_params).await.map_err(|e| e.to_string())?
        } else {
            stmt.query(()).await.map_err(|e| e.to_string())?
        };

        let mut results: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut rows_iter = rows; // make mutable
        while let Some(row) = rows_iter.next().await.map_err(|e| e.to_string())? {
            let mut values_vec = Vec::with_capacity(row.column_count() as usize);
            for i in 0..row.column_count() {
                let value_json = match row.get_value(i).map_err(|e| e.to_string())? {
                    libsql::Value::Text(s) => serde_json::Value::String(s),
                    libsql::Value::Integer(i) => serde_json::Value::Number(i.into()),
                    libsql::Value::Real(f) => serde_json::Value::Number(
                        serde_json::Number::from_f64(f).unwrap_or_else(|| 0.into()),
                    ),
                    libsql::Value::Null => serde_json::Value::Null,
                    libsql::Value::Blob(_) => serde_json::Value::String("BLOB".to_string()),
                };
                values_vec.push(value_json);
            }
            results.push(values_vec);
        }

        Ok(results)
    }

    // Also expose an optional `close` command to gracefully shut down the pool.
    #[command]
    pub async fn close(state: State<'_, Mutex<LibsqlState>>, _db: Option<String>) -> Result<bool, String> {
        let mut state = state.lock().await;
        state.db_pool = None;
        Ok(true)
    }
}

// Re-export so the main app can reference them directly as thunderbolt_libsql::init_libsql etc.
pub use commands::{init_libsql, execute, select};

// Also expose an optional `close` command to gracefully shut down the pool.
pub use commands::close;

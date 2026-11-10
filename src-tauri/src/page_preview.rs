/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Device-local app servers outlive agent turns, but remain owned by this app.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::watch,
};

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub id: String,
    pub cwd: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub port: Option<u16>,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub id: String,
    pub status: &'static str,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    #[serde(flatten)]
    pub state: PreviewState,
    pub logs: String,
}

struct Preview {
    request: PreviewRequest,
    state: watch::Sender<PreviewState>,
    cancel: watch::Sender<bool>,
    logs: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
pub struct PreviewSessions(Mutex<HashMap<String, Arc<Preview>>>);

fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if !cfg!(desktop) || webview.label() != "main" {
        return Err("Local apps require the desktop main window".into());
    }
    Ok(())
}

fn running(state: &PreviewState) -> bool {
    matches!(state.status, "starting" | "ready")
}

impl Preview {
    fn snapshot(&self) -> Result<PreviewSnapshot, String> {
        Ok(PreviewSnapshot {
            state: self.state.borrow().clone(),
            logs: String::from_utf8_lossy(&self.logs.lock().map_err(|error| error.to_string())?)
                .into_owned(),
        })
    }

    fn finish(&self, status: &'static str, error: Option<String>) {
        self.state.send_modify(|state| {
            state.status = status;
            state.url = None;
            state.error = error;
        });
    }

    async fn stop(&self) -> Result<(), String> {
        let mut changes = self.state.subscribe();
        self.cancel.send_replace(true);
        while running(&changes.borrow_and_update()) {
            changes.changed().await.map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

impl PreviewSessions {
    fn get(&self, id: &str) -> Result<Option<Arc<Preview>>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned())
    }

    fn start(&self, request: PreviewRequest) -> Result<PreviewSnapshot, String> {
        if request.id.is_empty()
            || request.id.len() > 128
            || !request
                .id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || b"-_".contains(&value))
        {
            return Err("Invalid local app identifier".into());
        }
        if request.executable.trim().is_empty()
            || request.executable.contains('\0')
            || request.args.iter().any(|arg| arg.contains('\0'))
        {
            return Err("Provide a valid executable and arguments".into());
        }
        let cwd = PathBuf::from(&request.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("Choose an existing absolute working directory".into());
        }
        if request.port == Some(0) {
            return Err("A fixed preview port must be greater than zero".into());
        }
        let mut sessions = self.0.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = sessions.get(&request.id) {
            if running(&existing.state.borrow()) {
                if existing.request != request {
                    return Err("Stop the running app before changing its launch command".into());
                }
                return existing.snapshot();
            }
        }
        // Reserve before spawning: an occupied fixed port must never open some other server.
        let reservation = TcpListener::bind(("127.0.0.1", request.port.unwrap_or(0)))
            .map_err(|error| format!("Preview port is unavailable: {error}"))?;
        let port = reservation
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let (state, _) = watch::channel(PreviewState {
            id: request.id.clone(),
            status: "starting",
            url: None,
            error: None,
        });
        let (cancel, cancel_rx) = watch::channel(false);
        let preview = Arc::new(Preview {
            request,
            state,
            cancel,
            logs: Arc::default(),
        });
        sessions.insert(preview.request.id.clone(), preview.clone());
        let worker = preview.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_preview(worker.clone(), reservation, port, cancel_rx).await {
                worker.finish("failed", Some(error));
            }
        });
        preview.snapshot()
    }

    pub async fn stop_all(&self) -> Result<(), String> {
        let sessions: Vec<_> = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect();
        // Signal all children before waiting so exit cleanup is concurrent.
        for session in &sessions {
            session.cancel.send_replace(true);
        }
        for session in sessions {
            session.stop().await?;
        }
        Ok(())
    }
}

async fn capture(
    mut reader: impl AsyncRead + Unpin,
    logs: Arc<Mutex<Vec<u8>>>,
) -> Result<(), String> {
    const LIMIT: usize = 64 * 1024;
    let mut buffer = [0u8; 4096];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(());
        }
        let mut logs = logs.lock().map_err(|error| error.to_string())?;
        logs.extend_from_slice(&buffer[..count]);
        let excess = logs.len().saturating_sub(LIMIT);
        logs.drain(..excess);
    }
}

async fn wait_ready(url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(400))
        .build()
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if client.get(url).send().await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "The app did not start an HTTP server within 30 seconds".to_string())
}

async fn run_preview(
    preview: Arc<Preview>,
    reservation: TcpListener,
    port: u16,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    if *cancel.borrow() {
        preview.finish("stopped", None);
        return Ok(());
    }
    let port_text = port.to_string();
    let args: Vec<_> = preview
        .request
        .args
        .iter()
        .map(|arg| arg.replace("{port}", &port_text))
        .collect();
    let mut command = Command::new(&preview.request.executable);
    command
        .args(args)
        .current_dir(&preview.request.cwd)
        .env("PORT", &port_text)
        .env("HOST", "127.0.0.1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    drop(reservation);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start local app: {error}"))?;
    let pid = child.id().ok_or("Missing local app process id")?;
    let stdout = tokio::spawn(capture(
        child.stdout.take().ok_or("Missing stdout")?,
        preview.logs.clone(),
    ));
    let stderr = tokio::spawn(capture(
        child.stderr.take().ok_or("Missing stderr")?,
        preview.logs.clone(),
    ));
    let url = format!("http://127.0.0.1:{port}/");
    let (alive, outcome) = tokio::select! {
        _ = cancel.changed() => (true, Ok(())),
        status = child.wait() => (false, Err(format!("Local app exited before becoming ready: {}", status.map_err(|error| error.to_string())?))),
        ready = wait_ready(&url) => {
            match ready {
                Err(error) => (true, Err(error)),
                Ok(()) => {
                    preview.state.send_modify(|state| { state.status = "ready"; state.url = Some(url); });
                    tokio::select! {
                        _ = cancel.changed() => (true, Ok(())),
                        status = child.wait() => (false, Err(format!("Local app exited: {}", status.map_err(|error| error.to_string())?))),
                    }
                }
            }
        }
    };
    let cleanup = crate::agent_execution::process_tree::stop(pid, alive).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    // Detached grandchildren cannot hold stdout open and delay stop indefinitely.
    for mut reader in [stdout, stderr] {
        if tokio::time::timeout(Duration::from_millis(250), &mut reader)
            .await
            .is_err()
        {
            reader.abort();
        }
    }
    cleanup?;
    outcome?;
    preview.finish("stopped", None);
    Ok(())
}

#[tauri::command]
pub async fn agent_preview_start(
    webview: tauri::Webview,
    state: tauri::State<'_, PreviewSessions>,
    request: PreviewRequest,
) -> Result<PreviewSnapshot, String> {
    require_main(&webview)?;
    state.start(request)
}

#[tauri::command]
pub fn agent_preview_status(
    webview: tauri::Webview,
    state: tauri::State<'_, PreviewSessions>,
    id: String,
) -> Result<Option<PreviewSnapshot>, String> {
    require_main(&webview)?;
    state
        .get(&id)?
        .map(|preview| preview.snapshot())
        .transpose()
}

#[tauri::command]
pub async fn agent_preview_stop(
    webview: tauri::Webview,
    state: tauri::State<'_, PreviewSessions>,
    id: String,
) -> Result<Option<PreviewSnapshot>, String> {
    require_main(&webview)?;
    let Some(preview) = state.get(&id)? else {
        return Ok(None);
    };
    preview.stop().await?;
    preview.snapshot().map(Some)
}

/// Called during RunEvent::Exit while the native runtime can still reap children.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreviewSessions>() {
        if let Err(error) = tauri::async_runtime::block_on(state.stop_all()) {
            eprintln!("Could not stop local app previews: {error}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    #[ignore = "subprocess fixture for preview lifecycle tests"]
    fn http_server() {
        let Ok(port) = std::env::var("PORT") else {
            return;
        };
        let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
        println!("Preview fixture is running");
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        }
    }

    fn request(id: &str) -> PreviewRequest {
        PreviewRequest {
            id: id.into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--ignored".into(),
                "--exact".into(),
                "page_preview::tests::http_server".into(),
                "--nocapture".into(),
            ],
            port: None,
        }
    }

    async fn settled(preview: &Preview) -> PreviewState {
        let mut changes = preview.state.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            while changes.borrow_and_update().status == "starting" {
                changes.changed().await.unwrap();
            }
            changes.borrow().clone()
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn start_is_idempotent_and_server_survives_until_stopped() {
        let sessions = PreviewSessions::default();
        sessions.start(request("lifecycle")).unwrap();
        let preview = sessions.get("lifecycle").unwrap().unwrap();
        let ready = settled(&preview).await;
        assert_eq!(ready.status, "ready", "{:?}", ready.error);
        let duplicate = sessions.start(request("lifecycle")).unwrap();
        assert_eq!(duplicate.state.url, ready.url);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(reqwest::get(ready.url.as_ref().unwrap())
            .await
            .unwrap()
            .status()
            .is_success());
        preview.stop().await.unwrap();
        assert_eq!(preview.state.borrow().status, "stopped");
        assert!(reqwest::get(ready.url.unwrap()).await.is_err());
        assert!(preview.snapshot().unwrap().logs.contains("Preview fixture"));
    }

    #[tokio::test]
    async fn shutdown_reaps_all_running_previews() {
        let sessions = PreviewSessions::default();
        sessions.start(request("shutdown-a")).unwrap();
        sessions.start(request("shutdown-b")).unwrap();
        let first = sessions.get("shutdown-a").unwrap().unwrap();
        let second = sessions.get("shutdown-b").unwrap().unwrap();
        assert_eq!(settled(&first).await.status, "ready");
        assert_eq!(settled(&second).await.status, "ready");
        sessions.stop_all().await.unwrap();
        assert_eq!(first.state.borrow().status, "stopped");
        assert_eq!(second.state.borrow().status, "stopped");
    }

    #[tokio::test]
    async fn occupied_ports_and_spawn_failures_do_not_open_other_servers() {
        let sessions = PreviewSessions::default();
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut conflicting = request("occupied");
        conflicting.port = Some(occupied.local_addr().unwrap().port());
        assert!(sessions.start(conflicting).is_err());
        assert!(sessions.get("occupied").unwrap().is_none());
        let mut missing = request("missing");
        missing.executable = "/does/not/exist/thunderbolt-preview".into();
        sessions.start(missing).unwrap();
        let failed = settled(&sessions.get("missing").unwrap().unwrap()).await;
        assert_eq!(failed.status, "failed");
        assert!(failed.error.unwrap().contains("Could not start local app"));
    }

    #[tokio::test]
    async fn capture_keeps_recent_bounded_output() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        capture(&vec![b'x'; 100_000][..], logs.clone())
            .await
            .unwrap();
        assert_eq!(logs.lock().unwrap().len(), 64 * 1024);
    }
}

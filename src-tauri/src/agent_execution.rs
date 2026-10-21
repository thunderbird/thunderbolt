/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Desktop execution backend. This is intentionally host access, not a sandbox.
//! Only the trusted main webview can call it; the agent's tools are approval-gated
//! before crossing IPC. User files are never removed when a chat is disposed.

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tokio::{io::AsyncReadExt, process::Command, sync::watch};

#[derive(Default)]
pub struct Commands(Mutex<HashMap<String, watch::Sender<bool>>>);

fn require_main(webview: &tauri::Webview) -> Result<(), String> {
    if !cfg!(desktop) || webview.label() != "main" {
        return Err("Computer execution is only available in the desktop main window".into());
    }
    Ok(())
}

fn working_directory(cwd: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Choose an existing absolute working directory".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn resolve_path(cwd: &str, path: &str) -> Result<PathBuf, String> {
    // PathBuf::join preserves absolute host paths, including Windows drive paths.
    Ok(working_directory(cwd)?.join(path))
}

fn read_file(path: PathBuf) -> Result<Vec<u8>, String> {
    use std::io::Read;
    const LIMIT: u64 = 25 * 1024 * 1024;
    if !path.is_file() {
        return Err("The read tool requires a regular file".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("File exceeds 25 MiB. Use a shell command to read a smaller section.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn agent_pick_workspace(
    webview: tauri::Webview,
    path: Option<String>,
    title: String,
) -> Result<Option<String>, String> {
    require_main(&webview)?;
    #[cfg(desktop)]
    {
        let initial = path
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or(webview.path().home_dir().map_err(|e| e.to_string())?);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview
            .dialog()
            .file()
            .set_parent(&webview.window())
            .set_title(title)
            .set_directory(initial)
            .pick_folder(move |selection| {
                let _ = sender.send(selection);
            });
        receiver
            .await
            .map_err(|e| e.to_string())?
            .map(|selection| {
                let path = selection.into_path().map_err(|e| e.to_string())?;
                working_directory(&path.to_string_lossy())
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .transpose()
    }
    #[cfg(not(desktop))]
    {
        let _ = (path, title);
        Err("Computer execution requires the desktop app".into())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOperation {
    Resolve,
    Read,
    Write,
    Temp,
}

#[tauri::command]
pub async fn agent_fs(
    webview: tauri::Webview,
    cwd: String,
    operation: FileOperation,
    path: Option<String>,
    content: Option<Vec<u8>>,
    prefix: Option<String>,
    suffix: Option<String>,
) -> Result<Value, String> {
    require_main(&webview)?;
    let temp_root = webview.path().temp_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        if matches!(operation, FileOperation::Temp) {
            // Names are generated here; callers cannot turn a log into an arbitrary write.
            let clean = |value: Option<String>| -> Result<String, String> {
                let value = value.unwrap_or_default();
                if value
                    .chars()
                    .any(|c| !c.is_ascii_alphanumeric() && !"-_.".contains(c))
                {
                    return Err("Invalid temporary filename".into());
                }
                Ok(value)
            };
            let file = tempfile::Builder::new()
                .prefix(&clean(prefix)?)
                .suffix(&clean(suffix)?)
                .tempfile_in(temp_root)
                .map_err(|e| e.to_string())?;
            let (_, path) = file.keep().map_err(|e| e.to_string())?;
            return Ok(json!(path));
        }
        let path = resolve_path(&cwd, &path.ok_or("Missing path")?)?;
        match operation {
            FileOperation::Resolve => Ok(json!(path)),
            FileOperation::Read => read_file(path)
                .map(|bytes| json!(bytes))
                .map_err(|e| e.to_string()),
            FileOperation::Write => {
                let content = content.ok_or("Missing file content")?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(path, content).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            FileOperation::Temp => unreachable!(),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn agent_prepare_command(
    webview: tauri::Webview,
    state: tauri::State<Commands>,
    id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let mut commands = state.0.lock().map_err(|e| e.to_string())?;
    if commands.contains_key(&id) {
        return Err("Command already registered".into());
    }
    commands.insert(id, watch::channel(false).0);
    Ok(())
}

#[tauri::command]
pub fn agent_cancel_command(
    webview: tauri::Webview,
    state: tauri::State<Commands>,
    id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    if let Some(sender) = state.0.lock().map_err(|e| e.to_string())?.get(&id) {
        sender.send_replace(true);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_forget_command(
    webview: tauri::Webview,
    state: tauri::State<Commands>,
    id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    failure: Option<&'static str>,
}

#[derive(Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

// Continue draining after the cap so a verbose child cannot deadlock on its pipe.
async fn capture(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    output: Arc<Mutex<CapturedOutput>>,
) -> Result<(), String> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let mut output = output.lock().map_err(|e| e.to_string())?;
        let retained = count.min(LIMIT - output.bytes.len());
        output.bytes.extend_from_slice(&buffer[..retained]);
        output.truncated |= retained < count;
    }
    Ok(())
}

async fn finish_capture(
    mut task: tokio::task::JoinHandle<Result<(), String>>,
    output: Arc<Mutex<CapturedOutput>>,
) -> Result<String, String> {
    // Detached descendants can retain the pipe after the shell is gone. Preserve
    // what we read, but never let pipe cleanup keep Stop or timeout pending.
    let drain_timed_out = match tokio::time::timeout(Duration::from_millis(250), &mut task).await {
        Ok(result) => {
            result.map_err(|e| e.to_string())??;
            false
        }
        Err(_) => {
            task.abort();
            let _ = task.await;
            true
        }
    };
    let output = output.lock().map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.truncated {
        text.push_str("\n[Output exceeded 4 MiB; truncated]");
    }
    if drain_timed_out {
        text.push_str("\n[Stopped capturing output from a detached process]");
    }
    Ok(text)
}

async fn stop_process_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // Kill the shell's group. Descendants that deliberately detach are outside it.
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    }
}

async fn run_shell(
    command: &str,
    cwd: &str,
    env: HashMap<String, String>,
    timeout: f64,
    mut cancel: watch::Receiver<bool>,
) -> Result<ShellOutput, String> {
    if !timeout.is_finite() || timeout <= 0.0 || timeout > 3600.0 {
        return Err("Command timeout must be between 0 and 3600 seconds".into());
    }
    if *cancel.borrow() {
        return Ok(ShellOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: -1,
            failure: Some("aborted"),
        });
    }
    let cwd = working_directory(cwd)?;
    let mut builder = Command::new(if cfg!(windows) { "bash" } else { "/bin/bash" });
    builder
        .args(["-lc", command])
        .current_dir(cwd)
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    builder.process_group(0);
    let mut child = builder.spawn().map_err(|e| e.to_string())?;
    let pid = child.id().ok_or("Missing process id")?;
    let stdout_output = Arc::new(Mutex::new(CapturedOutput::default()));
    let stderr_output = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout = tokio::spawn(capture(
        child.stdout.take().ok_or("Missing stdout")?,
        stdout_output.clone(),
    ));
    let stderr = tokio::spawn(capture(
        child.stderr.take().ok_or("Missing stderr")?,
        stderr_output.clone(),
    ));
    let outcome = tokio::select! {
        status = child.wait() => status.map(|s| (s.code().unwrap_or(-1), None)).map_err(|e| e.to_string()),
        _ = cancel.changed() => Ok((-1, Some("aborted"))),
        _ = tokio::time::sleep(Duration::from_secs_f64(timeout)) => Ok((-1, Some("timeout"))),
    };
    stop_process_tree(pid).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    let (stdout, stderr) = tokio::join!(
        finish_capture(stdout, stdout_output),
        finish_capture(stderr, stderr_output)
    );
    let (exit_code, failure) = outcome?;
    Ok(ShellOutput {
        stdout: stdout?,
        stderr: stderr?,
        exit_code,
        failure,
    })
}

#[tauri::command]
pub async fn agent_exec(
    webview: tauri::Webview,
    state: tauri::State<'_, Commands>,
    id: String,
    command: String,
    cwd: String,
    env: HashMap<String, String>,
    timeout: f64,
) -> Result<ShellOutput, String> {
    require_main(&webview)?;
    let cancel = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .ok_or("Command not registered")?
        .subscribe();
    let result = run_shell(&command, &cwd, env, timeout, cancel).await;
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn detached_pipe_cannot_hold_completion_and_keeps_partial_output() {
        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"partial output").await.unwrap();
        // Keep the writer alive, as a detached child inheriting the pipe would.
        let output = Arc::new(Mutex::new(CapturedOutput::default()));
        let capture_task = tokio::spawn(capture(reader, output.clone()));
        let result =
            tokio::time::timeout(Duration::from_secs(2), finish_capture(capture_task, output))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            result,
            "partial output\n[Stopped capturing output from a detached process]"
        );
        assert!(writer.write_all(b"after completion").await.is_err());
    }

    #[tokio::test]
    async fn capture_drains_large_output_and_marks_truncation() {
        let (mut writer, reader) = tokio::io::duplex(8192);
        let output = Arc::new(Mutex::new(CapturedOutput::default()));
        let capture_task = tokio::spawn(capture(reader, output.clone()));
        writer
            .write_all(&vec![b'x'; 4 * 1024 * 1024 + 1])
            .await
            .unwrap();
        drop(writer);
        let text = finish_capture(capture_task, output).await.unwrap();
        assert!(text.starts_with(&"x".repeat(4 * 1024 * 1024)));
        assert!(text.ends_with("[Output exceeded 4 MiB; truncated]"));
    }

    #[test]
    fn host_paths_and_regular_file_reads() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "real data").unwrap();
        assert_eq!(
            read_file(resolve_path(dir.path().to_str().unwrap(), "file.txt").unwrap()).unwrap(),
            b"real data"
        );
        assert_eq!(
            resolve_path(dir.path().to_str().unwrap(), "/etc/hosts").unwrap(),
            PathBuf::from("/etc/hosts")
        );
        assert!(working_directory("relative/path").is_err());
        assert!(read_file(PathBuf::from("/dev/zero")).is_err());
    }

    #[tokio::test]
    async fn stop_cancels_a_running_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let (sender, cancel) = watch::channel(false);
        let started = dir.path().join("started");
        let stop = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !started.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("descendant did not start");
            sender.send_replace(true);
        });
        let result = run_shell(
            "(touch started; sleep 0.3; touch unwanted) & wait",
            dir.path().to_str().unwrap(),
            HashMap::new(),
            5.0,
            cancel,
        )
        .await
        .unwrap();
        stop.await.unwrap();
        assert_eq!(result.failure, Some("aborted"));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!dir.path().join("unwanted").exists());
    }

    #[tokio::test]
    async fn shell_reads_and_writes_real_files() {
        let dir = tempfile::tempdir().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let output = run_shell(
            "printf native > result.txt; cat result.txt; printf error >&2",
            dir.path().to_str().unwrap(),
            HashMap::new(),
            5.0,
            cancel,
        )
        .await
        .unwrap();
        assert_eq!(output.stdout, "native");
        assert_eq!(output.stderr, "error");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("result.txt")).unwrap(),
            "native"
        );
    }

    #[tokio::test]
    async fn cancelled_commands_never_start() {
        let dir = tempfile::tempdir().unwrap();
        let (_sender, cancel) = watch::channel(true);
        let result = run_shell(
            "touch unwanted",
            dir.path().to_str().unwrap(),
            HashMap::new(),
            5.0,
            cancel,
        )
        .await
        .unwrap();
        assert_eq!(result.failure, Some("aborted"));
        assert!(!dir.path().join("unwanted").exists());
    }

    #[tokio::test]
    async fn timeout_stops_descendant_writes() {
        let dir = tempfile::tempdir().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let result = run_shell(
            "(touch started; sleep 1.5; touch unwanted) & wait",
            dir.path().to_str().unwrap(),
            HashMap::new(),
            0.5,
            cancel,
        )
        .await
        .unwrap();
        assert_eq!(result.failure, Some("timeout"));
        assert!(
            dir.path().join("started").exists(),
            "descendant must have started before timeout"
        );
        tokio::time::sleep(Duration::from_millis(1600)).await;
        assert!(!dir.path().join("unwanted").exists());
    }
}

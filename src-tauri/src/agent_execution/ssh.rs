/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! OpenSSH transports a one-shot, document-independent coding environment.
//! Local process ownership and the remote channel lease both participate in Stop.

use super::{process_tree::ScopedChild, require_main, ssh_credentials, Commands};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

const HELPER: &str = include_str!("ssh_helper.py");
const PREVIEW_HELPER: &str = include_str!("ssh_preview.py");
const MAX_WIRE_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize, Hash, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub(crate) environment_id: String,
    pub(crate) host: String,
    pub(crate) port: Option<u16>,
    pub(crate) username: Option<String>,
    pub(crate) identity_file: Option<String>,
    #[serde(default = "agent_authentication")]
    pub(crate) authentication: String,
    #[serde(default)]
    pub(crate) has_secret: bool,
}

fn agent_authentication() -> String {
    "agent".into()
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Probe,
    ListDirectories,
    Resolve,
    Read,
    Write,
    Restore,
    Temp,
    Cleanup,
    Exec,
}

#[derive(Deserialize, Serialize)]
pub struct SshRequest {
    operation: Operation,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    owner: String,
    path: Option<String>,
    content: Option<Vec<u8>>,
    prefix: Option<String>,
    suffix: Option<String>,
    command: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    timeout: Option<f64>,
    #[serde(default, rename = "forgetOnly")]
    forget_only: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct OutputFile {
    path: String,
    device: u64,
    inode: u64,
}

/// The native process, not an agent-supplied path, records output-file ownership.
#[derive(Default)]
pub struct SshOutputFiles(Mutex<HashMap<(SshConnection, String), Vec<OutputFile>>>);

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

pub(crate) fn validate_connection(connection: &SshConnection) -> Result<(), String> {
    if !valid_identifier(&connection.environment_id)
        || connection.host.is_empty()
        || connection.host.len() > 253
        || connection.host.starts_with('-')
        || !connection
            .host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_:[]%".contains(&byte))
    {
        return Err("Provide a valid SSH environment and hostname or SSH config alias".into());
    }
    if connection.port == Some(0) {
        return Err("SSH port must be between 1 and 65535".into());
    }
    if !["agent", "key", "password"].contains(&connection.authentication.as_str()) {
        return Err("Invalid SSH authentication method".into());
    }
    for value in [&connection.username, &connection.identity_file]
        .into_iter()
        .flatten()
    {
        if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("Invalid SSH username or identity file".into());
        }
    }
    if connection.username.as_ref().is_some_and(|username| {
        username.starts_with('-')
            || !username
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-@".contains(&byte))
    }) {
        return Err("Invalid SSH username".into());
    }
    if connection.authentication == "key" && connection.identity_file.is_none() {
        return Err("Choose a private key file".into());
    }
    Ok(())
}

fn validate(connection: &SshConnection, request: &SshRequest) -> Result<(), String> {
    validate_connection(connection)?;
    if request.forget_only && request.operation != Operation::Cleanup {
        return Err("Only output cleanup may forget local ownership".into());
    }
    if matches!(request.operation, Operation::Temp | Operation::Cleanup)
        && !valid_identifier(&request.owner)
    {
        return Err("Invalid output owner".into());
    }
    if matches!(request.operation, Operation::Write | Operation::Restore)
        && request.content.is_none()
    {
        return Err("Missing file content".into());
    }
    if request
        .content
        .as_ref()
        .is_some_and(|content| content.len() > MAX_FILE_BYTES)
    {
        return Err("File exceeds 25 MiB".into());
    }
    if let Some(timeout) = request.timeout {
        if !timeout.is_finite() || timeout <= 0.0 || timeout > 3600.0 {
            return Err("Command timeout must be between 0 and 3600 seconds".into());
        }
    }
    Ok(())
}

/// Only this fixed program enters the remote shell. All request data travels on stdin.
fn helper_command() -> String {
    format!("python3 -u -c '{}'", HELPER.replace('\'', "'\\''"))
}

pub(crate) fn ssh_client_command(
    connection: &SshConnection,
    askpass: bool,
    clear_forwardings: bool,
) -> Command {
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=8",
        "-oConnectionAttempts=1",
        "-oServerAliveInterval=5",
        "-oServerAliveCountMax=2",
        if clear_forwardings {
            "-oClearAllForwardings=yes"
        } else {
            "-oClearAllForwardings=no"
        },
        "-oForwardAgent=no",
        "-oForwardX11=no",
        "-oTunnel=no",
        "-oRemoteCommand=none",
        "-oNumberOfPasswordPrompts=1",
        "-oPermitLocalCommand=no",
        "-oRequestTTY=no",
        "-oForkAfterAuthentication=no",
        "-oStdinNull=no",
        "-oControlMaster=no",
        "-oControlPath=none",
        "-oUpdateHostKeys=no",
        "-oLogLevel=ERROR",
        if askpass {
            "-oBatchMode=no"
        } else {
            "-oBatchMode=yes"
        },
    ]);
    if connection.authentication == "password" {
        command.args([
            "-oPubkeyAuthentication=no",
            "-oPreferredAuthentications=password",
            "-oKbdInteractiveAuthentication=no",
        ]);
    }
    if connection.authentication == "key" {
        command.args([
            "-oPreferredAuthentications=publickey",
            "-oIdentitiesOnly=yes",
        ]);
    }
    if let Some(port) = connection.port {
        command.arg("-p").arg(port.to_string());
    }
    if let Some(username) = &connection.username {
        command.arg("-l").arg(username);
    }
    if let Some(identity) = &connection.identity_file {
        command.arg("-i").arg(identity);
    }
    command
}

fn ssh_command(connection: &SshConnection, askpass: bool) -> Command {
    let mut command = ssh_client_command(connection, askpass, true);
    command
        .arg("--")
        .arg(&connection.host)
        .arg(helper_command());
    command
}

/// Reuse connection-bound credentials without exposing their secret to preview code.
pub(crate) struct SshAuthentication(Option<ssh_credentials::AskpassSession>);

impl SshAuthentication {
    pub(crate) fn command(
        &self,
        connection: &SshConnection,
        clear_forwardings: bool,
    ) -> Result<Command, String> {
        let mut command = ssh_client_command(connection, self.0.is_some(), clear_forwardings);
        if let Some(askpass) = &self.0 {
            askpass.configure(&mut command)?;
        }
        Ok(command)
    }
}

pub(crate) async fn authenticate_preview(
    connection: &SshConnection,
) -> Result<SshAuthentication, String> {
    validate_connection(connection)?;
    Ok(SshAuthentication(
        ssh_credentials::prepare_askpass(connection).await?,
    ))
}

/// The preview uses the same path validation/process-group cleanup helpers, with a streaming lifecycle.
pub(crate) fn preview_script() -> String {
    format!("__name__ = 'thunderbolt_ssh_preview'\n{HELPER}\n{PREVIEW_HELPER}\npreview_main()")
}

pub(crate) fn preview_command() -> String {
    format!(
        "python3 -u -c '{}'",
        preview_script().replace('\'', "'\\''")
    )
}

async fn capture(mut stream: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > limit {
            return Err("SSH response exceeded its size limit".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

async fn finish_capture(
    mut task: tokio::task::JoinHandle<Result<Vec<u8>, String>>,
) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(result) => result.map_err(|error| error.to_string())?,
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err("SSH output did not close".into())
        }
    }
}

fn cancelled_value(operation: &Operation, failure: &'static str) -> Result<Value, String> {
    if *operation == Operation::Exec {
        return Ok(json!({ "stdout": "", "stderr": "", "exitCode": -1, "failure": failure }));
    }
    Err(if failure == "timeout" {
        "SSH operation timed out"
    } else {
        "SSH operation aborted"
    }
    .into())
}

/// stdin heartbeats let the remote supervisor stop commands after transport loss,
/// even when the remote TCP stack has not noticed the disconnected desktop yet.
async fn run_request(
    mut command: Command,
    payload: Value,
    operation: &Operation,
    timeout: f64,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    if *cancel.borrow() {
        return cancelled_value(operation, "aborted");
    }
    let mut encoded = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if encoded.len() >= MAX_WIRE_BYTES {
        return Err("SSH request exceeded its size limit".into());
    }
    encoded.push(b'\n');
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = ScopedChild::spawn(command)
        .map_err(|error| format!("Could not start SSH. Install an OpenSSH client: {error}"))?;
    let mut input = process.child().stdin.take().ok_or("Missing SSH stdin")?;
    let writer: tokio::task::JoinHandle<std::io::Result<()>> = tokio::spawn(async move {
        input.write_all(&encoded).await?;
        input.flush().await?;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            input.write_all(b"heartbeat\n").await?;
            input.flush().await?;
        }
    });
    let stdout = tokio::spawn(capture(
        process.child().stdout.take().ok_or("Missing SSH stdout")?,
        MAX_WIRE_BYTES,
    ));
    let stderr = tokio::spawn(capture(
        process.child().stderr.take().ok_or("Missing SSH stderr")?,
        64 * 1024,
    ));
    let outcome = tokio::select! {
        result = process.child().wait() => result.map(|status| (Some(status), None)).map_err(|error| error.to_string()),
        _ = cancel.changed() => Ok((None, Some("aborted"))),
        _ = tokio::time::sleep(Duration::from_secs_f64(timeout)) => Ok((None, Some("timeout"))),
    };
    // Close the channel first so its supervisor can reap remote children. Killing
    // only our local ssh process would not guarantee remote cleanup.
    writer.abort();
    let _ = writer.await;
    if matches!(outcome, Ok((_, Some(_)))) {
        let _ = tokio::time::timeout(Duration::from_secs(3), process.child().wait()).await;
    }
    let stopped = process.stop().await;
    let (stdout, stderr) = tokio::join!(finish_capture(stdout), finish_capture(stderr));
    let (status, failure) = outcome?;
    stopped?;
    if let Some(failure) = failure {
        return cancelled_value(operation, failure);
    }
    let stderr = stderr?;
    if !status.is_some_and(|status| status.success()) {
        return Err(format!(
            "SSH connection failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    let response: Value = serde_json::from_slice(&stdout?).map_err(|_| {
        "SSH returned an invalid response. Install Python 3 on the host and keep non-interactive shell startup quiet.".to_string()
    })?;
    if response.get("ok") != Some(&Value::Bool(true)) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("SSH request failed")
            .into());
    }
    Ok(response.get("value").cloned().unwrap_or(Value::Null))
}

/// Revoked profiles may release bookkeeping, but must never reconnect to their old host.
fn prepare_payload(
    output_files: &SshOutputFiles,
    key: &(SshConnection, String),
    request: &SshRequest,
) -> Result<Option<Value>, String> {
    let mut payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
    if request.operation != Operation::Cleanup {
        return Ok(Some(payload));
    }
    let mut owners = output_files.0.lock().map_err(|error| error.to_string())?;
    if request.forget_only {
        owners.remove(key);
        return Ok(None);
    }
    let files = owners.get(key).cloned().unwrap_or_default();
    if files.is_empty() {
        return Ok(None);
    }
    payload["files"] = json!(files);
    Ok(Some(payload))
}

#[tauri::command]
pub async fn agent_ssh_request(
    webview: tauri::Webview,
    commands: tauri::State<'_, Commands>,
    output_files: tauri::State<'_, SshOutputFiles>,
    id: String,
    connection: SshConnection,
    request: SshRequest,
) -> Result<Value, String> {
    require_main(&webview)?;
    validate(&connection, &request)?;
    let mut cancel = commands
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .ok_or("Command not registered")?
        .subscribe();
    let key = (connection.clone(), request.owner.clone());
    let Some(payload) = prepare_payload(&output_files, &key, &request)? else {
        return Ok(Value::Null);
    };
    if *cancel.borrow() {
        return cancelled_value(&request.operation, "aborted");
    }
    let askpass = tokio::select! {
        result = ssh_credentials::prepare_askpass(&connection) => result?,
        _ = cancel.changed() => return cancelled_value(&request.operation, "aborted"),
    };
    let mut command = ssh_command(&connection, askpass.is_some());
    if let Some(askpass) = &askpass {
        askpass.configure(&mut command)?;
    }
    let timeout = if request.operation == Operation::Exec {
        request.timeout.unwrap_or(120.0) + 15.0
    } else {
        30.0
    };
    let result = run_request(command, payload, &request.operation, timeout, cancel).await;
    drop(askpass);
    commands
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    let result = result?;
    if request.operation == Operation::Temp {
        let file: OutputFile = serde_json::from_value(result).map_err(|error| error.to_string())?;
        let path = file.path.clone();
        output_files
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .entry(key)
            .or_default()
            .push(file);
        return Ok(json!(path));
    }
    if request.operation == Operation::Cleanup {
        output_files
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&key);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> SshConnection {
        serde_json::from_value(json!({ "environmentId": "test-env", "host": "orb" })).unwrap()
    }

    fn request(value: Value) -> SshRequest {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn validates_connections_before_starting_a_process() {
        for host in [
            "",
            "-oProxyCommand=oops",
            "host;touch /tmp/x",
            "host\nother",
            "user@host",
            "$(id)",
        ] {
            assert!(
                validate_connection(&SshConnection {
                    host: host.into(),
                    ..connection()
                })
                .is_err(),
                "{host}"
            );
        }
        for host in [
            "orb",
            "ubuntu.orb.local",
            "127.0.0.1",
            "::1",
            "[fe80::1%en0]",
        ] {
            assert!(
                validate_connection(&SshConnection {
                    host: host.into(),
                    ..connection()
                })
                .is_ok(),
                "{host}"
            );
        }
        for username in ["user;id", "user name", "-o", "user\n"] {
            assert!(validate_connection(&SshConnection {
                username: Some(username.into()),
                ..connection()
            })
            .is_err());
        }
        assert!(validate_connection(&SshConnection {
            username: Some("alice@ubuntu".into()),
            ..connection()
        })
        .is_ok());
        assert!(validate_connection(&SshConnection {
            port: Some(0),
            ..connection()
        })
        .is_err());
        assert!(validate_connection(&SshConnection {
            environment_id: "../other".into(),
            ..connection()
        })
        .is_err());
        assert!(validate_connection(&SshConnection {
            authentication: "key".into(),
            ..connection()
        })
        .is_err());
        assert!(validate_connection(&SshConnection {
            authentication: "oops".into(),
            ..connection()
        })
        .is_err());
    }

    #[test]
    fn ssh_arguments_keep_config_and_credentials_out_of_the_shell() {
        let config = SshConnection {
            username: Some("alice".into()),
            port: Some(2222),
            identity_file: Some("/a folder/identity's key".into()),
            authentication: "key".into(),
            ..connection()
        };
        let command = ssh_command(&config, true);
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for flag in [
            "-oStrictHostKeyChecking=yes",
            "-oClearAllForwardings=yes",
            "-oPermitLocalCommand=no",
            "-oForwardAgent=no",
            "-oForwardX11=no",
            "-oTunnel=no",
            "-oRemoteCommand=none",
            "-oIdentitiesOnly=yes",
            "-oPreferredAuthentications=publickey",
            "-oBatchMode=no",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "{flag}");
        }
        assert_eq!(&args[args.len() - 3..], &["--", "orb", &helper_command()]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "/a folder/identity's key"]));
        assert!(!helper_command().contains("/a folder/identity"));
        let password = ssh_command(
            &SshConnection {
                authentication: "password".into(),
                ..connection()
            },
            true,
        );
        assert!(password
            .as_std()
            .get_args()
            .any(|arg| arg == "-oKbdInteractiveAuthentication=no"));
        assert!(ssh_command(&connection(), false)
            .as_std()
            .get_args()
            .any(|arg| arg == "-oBatchMode=yes"));
    }

    #[test]
    fn validates_request_limits_and_owned_cleanup() {
        for timeout in [0.0, -1.0, 3601.0] {
            assert!(validate(
                &connection(),
                &request(json!({"operation":"exec", "timeout":timeout}))
            )
            .is_err());
        }
        assert!(validate(
            &connection(),
            &request(json!({"operation":"temp", "owner":"../../"}))
        )
        .is_err());
        assert!(validate(
            &connection(),
            &request(json!({"operation":"cleanup", "owner":"owner"}))
        )
        .is_ok());
        assert!(validate(&connection(), &request(json!({"operation":"write"}))).is_err());
        assert!(validate(
            &connection(),
            &request(json!({"operation":"write", "content":[]}))
        )
        .is_ok());
        let mut oversized = request(json!({"operation":"write"}));
        oversized.content = Some(vec![0; MAX_FILE_BYTES + 1]);
        assert!(validate(&connection(), &oversized).is_err());
    }

    #[test]
    fn forgetting_revoked_output_ownership_has_no_remote_request() {
        let outputs = SshOutputFiles::default();
        let key = (connection(), "owner".into());
        outputs.0.lock().unwrap().insert(
            key.clone(),
            vec![OutputFile {
                path: "/remote/log".into(),
                device: 1,
                inode: 2,
            }],
        );
        let forget = request(json!({"operation":"cleanup", "owner":"owner", "forgetOnly":true}));
        assert!(prepare_payload(&outputs, &key, &forget).unwrap().is_none());
        assert!(outputs.0.lock().unwrap().is_empty());
        assert!(prepare_payload(&outputs, &key, &forget).unwrap().is_none());
        assert!(validate(
            &connection(),
            &request(json!({"operation":"exec", "forgetOnly":true}))
        )
        .is_err());
    }

    #[cfg(unix)]
    fn helper() -> Command {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", HELPER]);
        command
    }

    #[cfg(unix)]
    async fn remote(payload: Value) -> Result<Value, String> {
        let request = request(payload.clone());
        let (_keep, cancel) = watch::channel(false);
        run_request(helper(), payload, &request.operation, 10.0, cancel).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_probe_and_files_round_trip_binary_and_literal_paths() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().to_string_lossy().into_owned();
        let probe = remote(json!({"operation":"probe", "cwd":cwd}))
            .await
            .unwrap();
        assert!(probe["cwd"]
            .as_str()
            .unwrap()
            .ends_with(directory.path().file_name().unwrap().to_str().unwrap()));
        assert_eq!(
            probe["platform"],
            std::env::consts::OS.replace("macos", "darwin")
        );
        let name = "sub/quote' $HOME; $(touch nope).bin";
        remote(json!({"operation":"write", "cwd":cwd, "path":name, "content":[0,128,255,10]}))
            .await
            .unwrap();
        let bytes = remote(json!({"operation":"read", "cwd":cwd, "path":name}))
            .await
            .unwrap();
        assert_eq!(bytes, json!([0, 128, 255, 10]));
        let path = remote(json!({"operation":"resolve", "cwd":cwd, "path":name}))
            .await
            .unwrap();
        assert!(path.as_str().unwrap().ends_with(name));
        assert!(!directory.path().join("nope").exists());
        remote(json!({"operation":"restore", "cwd":cwd, "path":name, "content":[42]}))
            .await
            .unwrap();
        assert_eq!(
            remote(json!({"operation":"read", "cwd":cwd, "path":name}))
                .await
                .unwrap(),
            bytes
        );
        remote(json!({"operation":"restore", "cwd":cwd, "path":"restored", "content":[42]}))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("restored")).unwrap(),
            [42]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_list_directories_preserves_literal_names_and_sorts_only_folders() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        let expected_names = [
            ".hidden",
            "apple",
            "Banana",
            "quote' $HOME; $(touch nope)",
            "zeta",
            "雪\nfolder",
        ];
        for name in expected_names.iter().rev() {
            std::fs::create_dir(cwd.join(name)).unwrap();
        }
        std::fs::write(cwd.join("not-a-folder"), "file").unwrap();
        std::os::unix::fs::symlink(cwd.join("not-a-folder"), cwd.join("file-link")).unwrap();
        std::os::unix::fs::symlink(cwd.join("absent"), cwd.join("broken-link")).unwrap();

        let result = remote(json!({"operation":"list_directories", "cwd":cwd}))
            .await
            .unwrap();
        let expected: Vec<_> = expected_names
            .iter()
            .map(|name| json!({"name": name, "path": cwd.join(name)}))
            .collect();
        assert_eq!(result["path"], json!(cwd));
        assert_eq!(result["parentPath"], json!(cwd.parent().unwrap()));
        assert_eq!(result["directories"], json!(expected));
        assert!(!cwd.join("nope").exists());

        let literal = cwd.join("quote' $HOME; $(touch nope)");
        let empty = remote(json!({"operation":"list_directories", "cwd":literal}))
            .await
            .unwrap();
        assert_eq!(empty["path"], json!(literal));
        assert_eq!(empty["directories"], json!([]));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_list_directories_follows_directory_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        let target_path = target.path().canonicalize().unwrap();
        let link = cwd.join("linked folder");
        std::fs::create_dir(target_path.join("child")).unwrap();
        std::os::unix::fs::symlink(&target_path, &link).unwrap();

        let listing = remote(json!({"operation":"list_directories", "cwd":cwd}))
            .await
            .unwrap();
        assert_eq!(
            listing["directories"],
            json!([{"name":"linked folder", "path":link}])
        );
        let followed = remote(json!({"operation":"list_directories", "cwd":link}))
            .await
            .unwrap();
        assert_eq!(followed["path"], json!(target_path));
        assert_eq!(followed["parentPath"], json!(target_path.parent().unwrap()));
        assert_eq!(
            followed["directories"],
            json!([{"name":"child", "path":target_path.join("child")}])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_list_directories_rejects_missing_or_file_paths_and_stops_at_root() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("file");
        std::fs::write(&file, "not a directory").unwrap();
        for path in [directory.path().join("missing"), file] {
            assert!(remote(json!({"operation":"list_directories", "cwd":path}))
                .await
                .unwrap_err()
                .contains("existing absolute directory"));
        }
        let root = remote(json!({"operation":"list_directories", "cwd":"/"}))
            .await
            .unwrap();
        assert_eq!(root["path"], "/");
        assert!(root["parentPath"].is_null());
        assert!(root["directories"].is_array());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_rejects_non_regular_and_oversized_reads() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().to_string_lossy();
        assert!(remote(json!({"operation":"read", "cwd":cwd, "path":"."}))
            .await
            .unwrap_err()
            .contains("regular file"));
        let file = std::fs::File::create(directory.path().join("large")).unwrap();
        file.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
        assert!(
            remote(json!({"operation":"read", "cwd":cwd, "path":"large"}))
                .await
                .unwrap_err()
                .contains("25 MiB")
        );
        assert!(
            remote(json!({"operation":"probe", "cwd":"/does-not-exist-thunderbolt"}))
                .await
                .is_err()
        );
        assert!(
            remote(json!({"operation":"temp", "owner":"safe", "prefix":"../"}))
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_cleanup_removes_only_registered_unchanged_outputs() {
        let owner = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let file = remote(json!({"operation":"temp", "owner":owner, "prefix":"log-"}))
            .await
            .unwrap();
        let path = std::path::Path::new(file["path"].as_str().unwrap());
        let unrelated = path.with_file_name("user.txt");
        std::fs::write(&unrelated, "keep").unwrap();
        assert!(
            remote(json!({"operation":"cleanup", "owner":"wrong-owner", "files":[file]}))
                .await
                .is_err()
        );
        // A file replacing the owned inode must not be removed.
        let replaced = remote(json!({"operation":"temp", "owner":owner}))
            .await
            .unwrap();
        let replaced_path = std::path::Path::new(replaced["path"].as_str().unwrap());
        let saved = replaced_path.with_extension("original");
        std::fs::rename(replaced_path, &saved).unwrap();
        std::fs::write(replaced_path, "replacement").unwrap();
        remote(json!({"operation":"cleanup", "owner":owner, "files":[file,replaced]}))
            .await
            .unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "keep");
        assert_eq!(
            std::fs::read_to_string(replaced_path).unwrap(),
            "replacement"
        );
        std::fs::remove_file(unrelated).unwrap();
        std::fs::remove_file(replaced_path).unwrap();
        std::fs::remove_file(saved).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_exec_preserves_exit_status_cwd_env_and_bounded_output() {
        let directory = tempfile::tempdir().unwrap();
        let result = remote(json!({"operation":"exec", "cwd":directory.path(), "command":"printf '%s' \"$TEST_VALUE\"; printf bad >&2; exit 7", "env":{"TEST_VALUE":"quote' $()"}})).await.unwrap();
        assert_eq!(result["stdout"], "quote' $()");
        assert_eq!(result["stderr"], "bad");
        assert_eq!(result["exitCode"], 7);
        assert!(result["failure"].is_null());
        let result = remote(json!({"operation":"exec", "cwd":directory.path(), "command":"python3 -c 'import sys; sys.stdout.write(\"x\" * 5000000)'"})).await.unwrap();
        assert!(result["stdout"]
            .as_str()
            .unwrap()
            .ends_with("[Output exceeded 4 MiB; truncated]"));
        assert!(result["stdout"].as_str().unwrap().len() < 4 * 1024 * 1024 + 100);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_timeout_and_channel_cancellation_kill_command_children() {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path();
        let result = remote(json!({"operation":"exec", "cwd":cwd, "command":"(sleep 0.7; echo bad > timed-out) & wait", "timeout":0.1})).await.unwrap();
        assert_eq!(result["failure"], "timeout");
        let (cancel, receiver) = watch::channel(false);
        let payload = json!({"operation":"exec", "cwd":cwd, "command":"touch ready; (sleep 0.7; echo bad > cancelled) & wait"});
        let task = tokio::spawn(async move {
            run_request(helper(), payload, &Operation::Exec, 10.0, receiver).await
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !cwd.join("ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        cancel.send_replace(true);
        assert_eq!(task.await.unwrap().unwrap()["failure"], "aborted");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!cwd.join("timed-out").exists());
        assert!(!cwd.join("cancelled").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_supervisor_reaps_children_on_disconnect_lease_or_signal_without_local_cleanup()
    {
        let mut directories = Vec::new();
        for trigger in ["eof", "lease", "signal"] {
            let directory = tempfile::tempdir().unwrap();
            let cwd = directory.path();
            let source = HELPER.replace("LEASE_SECONDS = 12", "LEASE_SECONDS = 1");
            let mut child = Command::new("python3")
                .args(["-u", "-c", &source])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut input = child.stdin.take().unwrap();
            let payload = json!({"operation":"exec", "cwd":cwd, "command":"touch ready; (sleep 3; echo bad > leaked) & wait"});
            input
                .write_all(format!("{payload}\n").as_bytes())
                .await
                .unwrap();
            input.flush().await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while !cwd.join("ready").exists() {
                    input.write_all(b"heartbeat\n").await.unwrap();
                    input.flush().await.unwrap();
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            match trigger {
                "eof" => input.shutdown().await.unwrap(),
                "signal" => {
                    assert_eq!(
                        unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) },
                        0
                    );
                }
                _ => {}
            }
            let output = tokio::time::timeout(Duration::from_secs(3), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
            assert!(output.status.success());
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(result["value"]["failure"], "aborted");
            directories.push(directory);
        }
        tokio::time::sleep(Duration::from_millis(3200)).await;
        for directory in directories {
            assert!(!directory.path().join("leaked").exists());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_before_spawn_never_runs_and_protocol_errors_surface() {
        let (_cancel, receiver) = watch::channel(true);
        let result = run_request(
            Command::new("does-not-exist"),
            json!({}),
            &Operation::Exec,
            1.0,
            receiver,
        )
        .await
        .unwrap();
        assert_eq!(result["failure"], "aborted");
        let (_cancel, receiver) = watch::channel(false);
        let mut malformed = Command::new("python3");
        malformed.args(["-c", "print('login banner')"]);
        assert!(
            run_request(malformed, json!({}), &Operation::Probe, 2.0, receiver)
                .await
                .unwrap_err()
                .contains("invalid response")
        );
    }
}

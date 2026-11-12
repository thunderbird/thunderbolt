/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! A remote process lease and a separate loopback tunnel share one preview owner.

use super::{append_logs, capture, wait_ready, Preview, PreviewMode};
use crate::agent_execution::{
    process_tree::ScopedChild,
    ssh::{authenticate_preview, preview_command, SshAuthentication, SshConnection},
};
use serde::Deserialize;
use std::{net::TcpListener, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdout, Command},
    sync::{oneshot, watch},
    task::JoinHandle,
};

struct Client {
    process: ScopedChild,
    // Askpass must remain alive for every authentication/reconnect prompt of this client.
    _authentication: Option<SshAuthentication>,
    heartbeat: Option<JoinHandle<Result<(), String>>>,
    readers: Vec<JoinHandle<Result<(), String>>>,
}

impl Client {
    fn spawn(
        mut command: Command,
        authentication: Option<SshAuthentication>,
        preview: &Preview,
    ) -> Result<(Self, ChildStdout), String> {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut process = ScopedChild::spawn(command)?;
        let stdout = process.child().stdout.take().expect("piped stdout");
        let stderr = process.child().stderr.take().expect("piped stderr");
        Ok((
            Self {
                process,
                _authentication: authentication,
                heartbeat: None,
                readers: vec![tokio::spawn(capture(stderr, preview.logs.clone()))],
            },
            stdout,
        ))
    }

    async fn stop(&mut self) -> Result<(), String> {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
            let _ = heartbeat.await;
            // Closing stdin revokes the remote lease. Give it time to reap its group
            // before killing the local transport; network loss also expires the lease.
            let _ = tokio::time::timeout(Duration::from_secs(3), self.process.child().wait()).await;
        }
        let outcome = self.process.stop().await;
        for mut reader in self.readers.drain(..) {
            if tokio::time::timeout(Duration::from_millis(250), &mut reader)
                .await
                .is_err()
            {
                reader.abort();
            }
        }
        outcome
    }
}

#[derive(Default)]
struct Clients {
    config: Option<Client>,
    remote: Option<Client>,
    tunnel: Option<Client>,
}

impl Clients {
    async fn stop(&mut self) -> Result<(), String> {
        let mut outcome = Ok(());
        // Close the public entry point before the remote service.
        for client in [&mut self.tunnel, &mut self.remote, &mut self.config]
            .into_iter()
            .flatten()
        {
            if let Err(error) = client.stop().await {
                outcome = Err(error);
            }
        }
        outcome
    }
}

/// Reject configured forwards before enabling our single, explicitly loopback-bound tunnel.
fn validate_forwarding_config(
    config: &str,
    local_port: u16,
    remote_port: u16,
) -> Result<(), String> {
    let expected = format!("localforward [127.0.0.1]:{local_port} [127.0.0.1]:{remote_port}");
    let forwards: Vec<_> = config
        .lines()
        .filter(|line| {
            matches!(
                line.split_whitespace().next(),
                Some("localforward" | "remoteforward" | "dynamicforward")
            )
        })
        .collect();
    if forwards != [expected.as_str()] {
        return Err("This SSH alias includes unsupported port forwards. Use an SSH alias without LocalForward, RemoteForward, or DynamicForward for app previews".into());
    }
    Ok(())
}

async fn check_config(
    clients: &mut Clients,
    preview: &Preview,
    mut command: Command,
    local_port: u16,
    remote_port: u16,
) -> Result<(), String> {
    command.stdin(Stdio::null());
    let (mut client, stdout) = Client::spawn(command, None, preview)?;
    let (send, receive) = oneshot::channel();
    client.readers.push(tokio::spawn(async move {
        const LIMIT: u64 = 1024 * 1024;
        let mut bytes = Vec::new();
        let result = stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| error.to_string())
            .and_then(|_| {
                if bytes.len() as u64 > LIMIT {
                    return Err("SSH configuration exceeds 1 MiB".into());
                }
                String::from_utf8(bytes).map_err(|error| error.to_string())
            });
        let _ = send.send(result);
        Ok(())
    }));
    clients.config = Some(client);
    let config = tokio::time::timeout(Duration::from_secs(15), async {
        let status = clients
            .config
            .as_mut()
            .expect("registered config")
            .process
            .child()
            .wait()
            .await
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Could not resolve the SSH configuration; check preview logs".into());
        }
        receive.await.map_err(|error| error.to_string())?
    })
    .await
    .map_err(|_| "SSH configuration resolution timed out".to_string())??;
    validate_forwarding_config(&config, local_port, remote_port)?;
    clients
        .config
        .as_mut()
        .expect("registered config")
        .stop()
        .await?;
    clients.config = None;
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum RemoteEvent {
    Started { port: u16 },
    Log { text: String },
    Exited { code: i32 },
    Failed { error: String },
}

#[derive(Clone)]
enum RemoteState {
    Starting,
    Started(u16),
    Failed(String),
}

async fn read_remote(
    stdout: ChildStdout,
    state: watch::Sender<RemoteState>,
    preview: Arc<Preview>,
) -> Result<(), String> {
    let result = async {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let count = (&mut reader)
                .take(64 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|error| error.to_string())?;
            if count == 0 {
                return Err("SSH preview channel closed".to_string());
            }
            if count > 64 * 1024 {
                return Err("SSH preview event exceeds 64 KiB".into());
            }
            match serde_json::from_slice::<RemoteEvent>(&line)
                .map_err(|error| format!("Invalid SSH preview event: {error}"))?
            {
                RemoteEvent::Started { port } => {
                    if port == 0 || !matches!(*state.borrow(), RemoteState::Starting) {
                        return Err("Invalid SSH preview port announcement".into());
                    }
                    state.send_replace(RemoteState::Started(port));
                }
                RemoteEvent::Log { text } => append_logs(&preview.logs, text.as_bytes())?,
                RemoteEvent::Exited { code } => {
                    return Err(format!("SSH app exited with code {code}"))
                }
                RemoteEvent::Failed { error } => {
                    return Err(format!("Could not start SSH app: {error}"))
                }
            }
        }
    }
    .await;
    if let Err(error) = &result {
        state.send_replace(RemoteState::Failed(error.clone()));
    }
    result
}

async fn start_remote(
    clients: &mut Clients,
    preview: Arc<Preview>,
    connection: &SshConnection,
) -> Result<watch::Receiver<RemoteState>, String> {
    let authentication = authenticate_preview(connection).await?;
    let mut command = authentication.command(connection, true)?;
    command
        .args(["--", &connection.host, &preview_command()])
        .stdin(Stdio::piped());
    spawn_remote(clients, preview, command, Some(authentication))
}

fn spawn_remote(
    clients: &mut Clients,
    preview: Arc<Preview>,
    command: Command,
    authentication: Option<SshAuthentication>,
) -> Result<watch::Receiver<RemoteState>, String> {
    let (mut client, stdout) = Client::spawn(command, authentication, &preview)?;
    let mut stdin = client.process.child().stdin.take().expect("piped stdin");
    let request = serde_json::to_vec(&serde_json::json!({
        "cwd": preview.request.cwd,
        "executable": preview.request.executable,
        "args": preview.request.args,
        "port": preview.request.port,
    }))
    .expect("preview request contains only JSON values");
    client.heartbeat = Some(tokio::spawn(async move {
        stdin
            .write_all(&request)
            .await
            .map_err(|error| error.to_string())?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| error.to_string())?;
        loop {
            stdin.flush().await.map_err(|error| error.to_string())?;
            tokio::time::sleep(Duration::from_secs(2)).await;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|error| error.to_string())?;
        }
    }));
    let (state, receiver) = watch::channel(RemoteState::Starting);
    client
        .readers
        .push(tokio::spawn(read_remote(stdout, state, preview)));
    clients.remote = Some(client);
    Ok(receiver)
}

async fn remote_port(state: &mut watch::Receiver<RemoteState>) -> Result<u16, String> {
    loop {
        match state.borrow_and_update().clone() {
            RemoteState::Started(port) => return Ok(port),
            RemoteState::Failed(error) => return Err(error),
            RemoteState::Starting => (),
        }
        state
            .changed()
            .await
            .map_err(|_| "SSH preview channel closed".to_string())?;
    }
}

async fn remote_failure(state: &mut Option<watch::Receiver<RemoteState>>) -> String {
    let Some(state) = state else {
        return std::future::pending().await;
    };
    loop {
        if let RemoteState::Failed(error) = state.borrow_and_update().clone() {
            return error;
        }
        if state.changed().await.is_err() {
            return "SSH preview channel closed".into();
        }
    }
}

fn tunnel_command(
    authentication: &SshAuthentication,
    connection: &SshConnection,
    local_port: u16,
    remote_port: u16,
    resolve_config: bool,
) -> Result<Command, String> {
    let mut command = authentication.command(connection, false)?;
    if resolve_config {
        command.arg("-G");
    }
    command
        .args([
            "-N",
            "-oExitOnForwardFailure=yes",
            "-oGatewayPorts=no",
            "-oForkAfterAuthentication=no",
            "-L",
            &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "--",
            &connection.host,
        ])
        .stdin(Stdio::null());
    Ok(command)
}

async fn run_connected(
    clients: &mut Clients,
    preview: Arc<Preview>,
    reservation: TcpListener,
    local_port: u16,
) -> Result<(), String> {
    let connection = preview.request.connection.as_ref().expect("SSH request");
    let (remote_port, mut remote_state) = match preview.request.mode {
        PreviewMode::Attach => (preview.request.port.expect("validated attach port"), None),
        PreviewMode::Launch => {
            let mut state = start_remote(clients, preview.clone(), connection).await?;
            let port = tokio::time::timeout(Duration::from_secs(30), remote_port(&mut state))
                .await
                .map_err(|_| "SSH app launch timed out".to_string())??;
            (port, Some(state))
        }
    };
    let authentication = tokio::select! {
        error = remote_failure(&mut remote_state) => return Err(error),
        authentication = authenticate_preview(connection) => authentication?,
    };
    // ~/.ssh/config is trusted local input. Evaluate the same invocation (not a
    // generic ssh -G): Match sessiontype/command rules can otherwise hide forwards.
    let config_command =
        tunnel_command(&authentication, connection, local_port, remote_port, true)?;
    check_config(clients, &preview, config_command, local_port, remote_port).await?;
    let command = tunnel_command(&authentication, connection, local_port, remote_port, false)?;
    drop(reservation);
    let (mut tunnel, stdout) = Client::spawn(command, Some(authentication), &preview)?;
    tunnel
        .readers
        .push(tokio::spawn(capture(stdout, preview.logs.clone())));
    clients.tunnel = Some(tunnel);
    let tunnel = clients.tunnel.as_mut().expect("registered tunnel");
    let url = format!("http://127.0.0.1:{local_port}/");
    tokio::select! {
        error = remote_failure(&mut remote_state) => Err(error),
        status = tunnel.process.child().wait() => Err(format!("SSH preview tunnel exited: {}; check preview logs", status.map_err(|error| error.to_string())?)),
        ready = wait_ready(&url) => {
            ready?;
            preview.state.send_modify(|state| { state.status = "ready"; state.url = Some(url); });
            tokio::select! {
                error = remote_failure(&mut remote_state) => Err(error),
                status = tunnel.process.child().wait() => Err(format!("SSH preview tunnel exited: {}", status.map_err(|error| error.to_string())?)),
            }
        }
    }
}

async fn startup_timeout(preview: &Preview) -> String {
    let mut changes = preview.state.subscribe();
    let ready = async {
        while changes.borrow_and_update().status == "starting" {
            if changes.changed().await.is_err() {
                return;
            }
        }
    };
    if tokio::time::timeout(Duration::from_secs(120), ready)
        .await
        .is_err()
    {
        return "SSH preview startup timed out after 120 seconds".into();
    }
    std::future::pending().await
}

pub(super) async fn run(
    preview: Arc<Preview>,
    reservation: TcpListener,
    local_port: u16,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut clients = Clients::default();
    let outcome = tokio::select! {
        biased;
        _ = async { if !*cancel.borrow_and_update() { let _ = cancel.changed().await; } } => Ok(()),
        error = startup_timeout(&preview) => Err(error),
        outcome = run_connected(&mut clients, preview.clone(), reservation, local_port) => outcome,
    };
    let cleanup = clients.stop().await;
    outcome.and(cleanup)?;
    preview.finish("stopped", None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn config_resolution_uses_the_exact_foreground_loopback_tunnel_options() {
        let connection: SshConnection = serde_json::from_value(serde_json::json!({
            "environmentId":"fixture", "host":"example.invalid", "username":"alice", "port":2222
        }))
        .unwrap();
        // Agent auth has no vault entry and never asks the OS for a credential.
        let authentication = authenticate_preview(&connection).await.unwrap();
        let args = |command: Command| {
            command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let tunnel =
            args(tunnel_command(&authentication, &connection, 49101, 49102, false).unwrap());
        let config =
            args(tunnel_command(&authentication, &connection, 49101, 49102, true).unwrap());
        assert_eq!(
            config
                .into_iter()
                .filter(|arg| arg != "-G")
                .collect::<Vec<_>>(),
            tunnel
        );
        for flag in [
            "-N",
            "-oStrictHostKeyChecking=yes",
            "-oGatewayPorts=no",
            "-oForkAfterAuthentication=no",
            "-oStdinNull=no",
            "-oTunnel=no",
            "-oExitOnForwardFailure=yes",
            "-oForwardAgent=no",
            "-oForwardX11=no",
            "-oClearAllForwardings=no",
        ] {
            assert!(tunnel.iter().any(|arg| arg == flag), "{flag}");
        }
        assert!(tunnel
            .windows(2)
            .any(|args| args == ["-L", "127.0.0.1:49101:127.0.0.1:49102"]));
        assert_eq!(&tunnel[tunnel.len() - 2..], ["--", "example.invalid"]);
    }

    #[test]
    fn configured_forwards_are_rejected_except_the_owned_loopback_tunnel() {
        let own = "localforward [127.0.0.1]:49101 [127.0.0.1]:49102\n";
        assert!(validate_forwarding_config(
            &format!("hostname vm.internal\nproxyjump bastion\n{own}"),
            49101,
            49102
        )
        .is_ok());
        for directive in ["localforward", "remoteforward", "dynamicforward"] {
            assert!(validate_forwarding_config(
                &format!("{own}{directive} 0.0.0.0:9000 localhost:22\n"),
                49101,
                49102
            )
            .is_err());
        }
        assert!(validate_forwarding_config("", 49101, 49102).is_err());
        assert!(validate_forwarding_config(own, 49101, 49103).is_err());
        assert!(validate_forwarding_config(&format!("{own}{own}"), 49101, 49102).is_err());
    }
}

#[cfg(all(test, unix))]
mod supervisor_tests {
    use super::*;
    use crate::agent_execution::ssh::preview_script;
    use crate::page_preview::{PreviewRequest, PreviewState};
    use std::{net::TcpStream, sync::Mutex};

    fn preview(script: &str, port: Option<u16>) -> Arc<Preview> {
        let request: PreviewRequest = serde_json::from_value(serde_json::json!({
            "id": "remote-fixture", "cwd": std::env::temp_dir(),
            "executable": "python3", "args": ["-u", "-c", script, "{port}", "$(not-a-shell)"], "port": port,
            "connection": {"environmentId":"fixture", "host":"example.invalid"}
        })).unwrap();
        let (state, _) = watch::channel(PreviewState {
            id: request.id.clone(),
            status: "starting",
            url: None,
            error: None,
        });
        let (cancel, _) = watch::channel(false);
        Arc::new(Preview {
            request,
            state,
            cancel,
            logs: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn spawn_fixture(
        clients: &mut Clients,
        preview: Arc<Preview>,
        lease: Option<f64>,
    ) -> watch::Receiver<RemoteState> {
        let script = match lease {
            Some(seconds) => preview_script()
                .replace("LEASE_SECONDS = 12", &format!("LEASE_SECONDS = {seconds}")),
            None => preview_script(),
        };
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &script]).stdin(Stdio::piped());
        spawn_remote(clients, preview, command, None).unwrap()
    }

    const SERVER: &str = r#"
import os, subprocess, sys, time
assert sys.argv[1] == os.environ['PORT']
assert sys.argv[2] == '$(not-a-shell)'
assert os.environ['HOST'] == '127.0.0.1'
subprocess.Popen([sys.executable, '-m', 'http.server', os.environ['PORT'], '--bind', '127.0.0.1'])
print('owned child is running', flush=True)
while True: time.sleep(.1)
"#;

    #[tokio::test]
    async fn cancelled_start_never_enters_authentication_or_launch() {
        let preview = preview(SERVER, None);
        let (cancel, receiver) = watch::channel(true);
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        run(preview.clone(), reservation, port, receiver)
            .await
            .unwrap();
        assert_eq!(preview.state.borrow().status, "stopped");
        assert!(preview.snapshot().unwrap().logs.is_empty());
        drop(cancel);
    }

    #[tokio::test]
    async fn remote_port_is_independent_and_disconnect_reaps_server_descendants() {
        let local = TcpListener::bind("127.0.0.1:0").unwrap();
        let preview = preview(SERVER, None);
        let mut clients = Clients::default();
        let mut state = spawn_fixture(&mut clients, preview.clone(), None);
        let port = tokio::time::timeout(Duration::from_secs(5), remote_port(&mut state))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(port, local.local_addr().unwrap().port());
        tokio::time::timeout(
            Duration::from_secs(5),
            wait_ready(&format!("http://127.0.0.1:{port}/")),
        )
        .await
        .unwrap()
        .unwrap();
        // Lease stays alive across multiple normal tool-length intervals.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        clients.stop().await.unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(preview
            .snapshot()
            .unwrap()
            .logs
            .contains("owned child is running"));
    }

    #[tokio::test]
    async fn fixed_remote_port_restarts_after_a_completed_http_request() {
        const SERVER_CLOSES_FIRST: &str = r#"
import os, socket
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', int(os.environ['PORT'])))
server.listen()
while True:
    connection, _ = server.accept()
    connection.recv(4096)
    connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    connection.shutdown(socket.SHUT_WR)
    while connection.recv(1024): pass
    connection.close()
    print('HTTP request completed', flush=True)
"#;
        let mut port = None;
        for _ in 0..2 {
            let preview = preview(SERVER_CLOSES_FIRST, port);
            let mut clients = Clients::default();
            let mut state = spawn_fixture(&mut clients, preview.clone(), None);
            let started = tokio::time::timeout(Duration::from_secs(5), remote_port(&mut state))
                .await
                .unwrap();
            if let Err(error) = &started {
                clients.stop().await.unwrap();
                panic!("Could not restart the fixed remote port: {error}");
            }
            let active_port = started.unwrap();
            if let Some(expected) = port {
                assert_eq!(active_port, expected);
            }
            port = Some(active_port);
            let response = tokio::time::timeout(Duration::from_secs(5), async {
                let mut connection = loop {
                    match tokio::net::TcpStream::connect(("127.0.0.1", active_port)).await {
                        Ok(connection) => break connection,
                        Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                };
                connection
                    .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                let mut response = Vec::new();
                connection.read_to_end(&mut response).await.unwrap();
                drop(connection);
                // The server actively closes, then observes the client's FIN. Its
                // accepted socket enters TIME_WAIT before the listener is stopped.
                while !preview
                    .snapshot()
                    .unwrap()
                    .logs
                    .contains("HTTP request completed")
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                response
            })
            .await;
            clients.stop().await.unwrap();
            assert!(response.unwrap().ends_with(b"\r\n\r\nok"));
        }
    }

    #[tokio::test]
    async fn occupied_remote_port_fails_without_touching_existing_service() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = occupied.local_addr().unwrap().port();
        let mut clients = Clients::default();
        let mut state = spawn_fixture(&mut clients, preview(SERVER, Some(port)), None);
        let error = tokio::time::timeout(Duration::from_secs(5), remote_port(&mut state))
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("Could not start SSH app"), "{error}");
        clients.stop().await.unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    }

    #[tokio::test]
    async fn lost_heartbeat_reaps_remote_server_without_a_stop_request() {
        let mut clients = Clients::default();
        let mut state = spawn_fixture(&mut clients, preview("import os,socket; s=socket.socket(); s.bind(('127.0.0.1',int(os.environ['PORT']))); s.listen();\nwhile True:\n c,_=s.accept(); c.recv(1024); c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length:0\\r\\n\\r\\n'); c.close()", None), Some(1.5));
        let port = tokio::time::timeout(Duration::from_secs(5), remote_port(&mut state))
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            wait_ready(&format!("http://127.0.0.1:{port}/")),
        )
        .await
        .unwrap()
        .unwrap();
        // The fixture lease is shorter than the normal two-second heartbeat.
        tokio::time::timeout(Duration::from_secs(5), remote_failure(&mut Some(state)))
            .await
            .unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        clients.stop().await.unwrap();
    }

    #[tokio::test]
    async fn remote_exit_and_malformed_events_are_reported_as_failures() {
        let mut clients = Clients::default();
        let mut state = spawn_fixture(&mut clients, preview("import sys; sys.exit(7)", None), None);
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            remote_failure(&mut Some(state.clone())),
        )
        .await
        .unwrap();
        assert!(error.contains("code 7"), "{error}");
        assert!(remote_port(&mut state).await.is_err());
        clients.stop().await.unwrap();

        let preview = preview("", None);
        let mut command = Command::new("python3");
        command
            .args(["-c", "print('x' * 70000)"])
            .stdin(Stdio::null());
        let (mut client, stdout) = Client::spawn(command, None, &preview).unwrap();
        let (sender, _) = watch::channel(RemoteState::Starting);
        let error = read_remote(stdout, sender, preview).await.unwrap_err();
        assert!(error.contains("64 KiB"));
        client.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stalled_output_cannot_prevent_lease_cleanup() {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        let script = preview_script().replace("LEASE_SECONDS = 12", "LEASE_SECONDS = 0.5");
        let mut command = Command::new("python3");
        command
            .args(["-u", "-c", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut process = ScopedChild::spawn(command).unwrap();
        let mut input = process.child().stdin.take().unwrap();
        let stdout = process.child().stdout.take().unwrap();
        let request = serde_json::json!({ "cwd":std::env::temp_dir(), "executable":"python3", "port":port,
            "args":["-u", "-c", "import http.server,os,threading; s=http.server.HTTPServer(('127.0.0.1',int(os.environ['PORT'])),http.server.SimpleHTTPRequestHandler); threading.Thread(target=s.serve_forever,daemon=True).start();\nwhile True: print('x'*4000,flush=True)"] });
        drop(reservation);
        input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        // Deliberately retain the unread pipe and open stdin, as a wedged client would.
        tokio::time::timeout(Duration::from_secs(5), process.child().wait())
            .await
            .unwrap()
            .unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        drop((input, stdout));
        process.stop().await.unwrap();
    }
}

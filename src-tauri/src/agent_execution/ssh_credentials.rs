/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Passwords stay in the OS vault. OpenSSH receives one through a short-lived
//! loopback askpass exchange, never through its arguments, environment or disk.

use super::ssh::{validate_connection, SshConnection};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(desktop)]
const SERVICE: &str = "net.thunderbird.thunderbolt.ssh";
#[cfg(desktop)]
static VAULT_ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
const ENDPOINT_ENV: &str = "THUNDERBOLT_SSH_ASKPASS_ENDPOINT";
const TOKEN_ENV: &str = "THUNDERBOLT_SSH_ASKPASS_TOKEN";
const MAX_SECRET_BYTES: usize = 4096;
const MAX_REQUEST_BYTES: u64 = 8192;
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    connection: SshConnection,
    secret: String,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

trait CredentialStore {
    fn read(&self, environment_id: &str) -> Result<Option<String>, String>;
    fn write(&self, environment_id: &str, value: &str) -> Result<(), String>;
    fn remove(&self, environment_id: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

#[cfg(desktop)]
fn lock_vault() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    // An OS unlock prompt can outlive an async timeout. Keep its worker's lock
    // until the actual vault call returns, so retries cannot stack prompts.
    VAULT_ACCESS
        .try_lock()
        .map_err(|_| "The system credential store is busy. Finish its prompt and try again".into())
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn system_entry(service: &str, environment_id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(service, environment_id)
}

#[cfg(target_os = "windows")]
fn system_entry(service: &str, environment_id: &str) -> keyring::Result<keyring::Entry> {
    // Initialize keyring's native backend, then override its roaming default.
    let mut entry = keyring::Entry::new(service, environment_id)?;
    entry.inner = keyring_core::Entry::new_with_modifiers(
        service,
        environment_id,
        &std::collections::HashMap::from([("persistence", "Local")]),
    )?;
    Ok(entry)
}

fn credential_target(connection: &SshConnection) -> SshConnection {
    SshConnection {
        has_secret: false,
        ..connection.clone()
    }
}

#[cfg(desktop)]
impl CredentialStore for SystemCredentialStore {
    fn read(&self, environment_id: &str) -> Result<Option<String>, String> {
        let _access = lock_vault()?;
        match system_entry(SERVICE, environment_id)
            .map_err(|_| "The system credential store is unavailable or locked")?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("The system credential store is unavailable or locked".into()),
        }
    }

    fn write(&self, environment_id: &str, value: &str) -> Result<(), String> {
        let _access = lock_vault()?;
        system_entry(SERVICE, environment_id)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| "Could not save the SSH secret in the system credential store".into())
    }

    fn remove(&self, environment_id: &str) -> Result<(), String> {
        let _access = lock_vault()?;
        match system_entry(SERVICE, environment_id)
            .map_err(|_| "The system credential store is unavailable or locked")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => {
                Err("Could not remove the SSH secret from the system credential store".into())
            }
        }
    }
}

#[cfg(not(desktop))]
impl CredentialStore for SystemCredentialStore {
    fn read(&self, _: &str) -> Result<Option<String>, String> {
        Err("SSH credentials require the desktop app".into())
    }
    fn write(&self, _: &str, _: &str) -> Result<(), String> {
        Err("SSH credentials require the desktop app".into())
    }
    fn remove(&self, _: &str) -> Result<(), String> {
        Err("SSH credentials require the desktop app".into())
    }
}

fn save_secret(
    store: &impl CredentialStore,
    connection: SshConnection,
    secret: Option<String>,
) -> Result<(), String> {
    let secret = secret.map(Zeroizing::new);
    validate_connection(&connection)?;
    let Some(secret) = secret else {
        return store.remove(&connection.environment_id);
    };
    if connection.authentication == "agent" {
        return Err("SSH agent authentication does not store a password".into());
    }
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES || secret.contains(['\0', '\r', '\n']) {
        return Err("Provide a nonempty SSH password or passphrase without line breaks".into());
    }
    let credential = StoredCredential {
        connection: credential_target(&connection),
        secret: secret.to_string(),
    };
    let encoded = Zeroizing::new(
        serde_json::to_string(&credential).map_err(|_| "Could not encode the SSH credential")?,
    );
    store.write(&credential.connection.environment_id, &encoded)
}

fn load_secret(
    store: &impl CredentialStore,
    connection: &SshConnection,
) -> Result<Option<Zeroizing<String>>, String> {
    if connection.authentication == "agent"
        || (connection.authentication == "key" && !connection.has_secret)
    {
        return Ok(None);
    }
    let Some(encoded) = store.read(&connection.environment_id)?.map(Zeroizing::new) else {
        return if connection.authentication == "password" {
            Err("Enter and save a password for this SSH environment".into())
        } else {
            Ok(None)
        };
    };
    let credential: StoredCredential =
        serde_json::from_str(&encoded).map_err(|_| "Save the SSH credential again")?;
    if credential.connection != credential_target(connection) {
        return Err("The SSH connection changed. Enter its password or passphrase again.".into());
    }
    Ok(Some(Zeroizing::new(credential.secret.clone())))
}

/// Store or forget one secret without ever returning it to the webview.
#[tauri::command]
pub async fn agent_ssh_set_secret(
    webview: tauri::Webview,
    connection: SshConnection,
    secret: Option<String>,
) -> Result<(), String> {
    super::require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_secret(&SystemCredentialStore, connection, secret)
    })
    .await
    .map_err(|_| "Could not access the SSH credential store")?
}

#[derive(Serialize, Deserialize)]
struct AskpassRequest {
    token: String,
    prompt: String,
}

fn accepts_prompt(authentication: &str, prompt: &str) -> bool {
    let prompt = prompt.trim().to_ascii_lowercase();
    match authentication {
        "password" => prompt.ends_with("'s password:") && !prompt.contains(['\r', '\n']),
        "key" => {
            prompt.starts_with("enter passphrase for key ")
                && prompt.ends_with(':')
                && !prompt.contains(['\r', '\n'])
        }
        _ => false,
    }
}

fn tokens_match(expected: &str, actual: &str) -> bool {
    expected.len() == actual.len()
        && expected
            .bytes()
            .zip(actual.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}

async fn answer_prompt(
    stream: tokio::net::TcpStream,
    token: &str,
    authentication: &str,
    secret: &str,
    used: &mut bool,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_BYTES));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|_| "Could not read SSH authentication request")?;
    if !line.ends_with('\n') {
        return Ok(());
    }
    let Ok(request) = serde_json::from_str::<AskpassRequest>(&line) else {
        return Ok(());
    };
    if !tokens_match(token, &request.token) || !accepts_prompt(authentication, &request.prompt) {
        return Ok(());
    }
    // Consume before writing: a peer that disconnects after a partial response
    // must not be able to obtain a second response using the same token.
    *used = true;
    let mut stream = reader.into_inner().into_inner();
    stream
        .write_all(secret.as_bytes())
        .await
        .map_err(|_| "Could not answer SSH authentication request")?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|_| "Could not answer SSH authentication request")?;
    stream
        .shutdown()
        .await
        .map_err(|_| "Could not finish SSH authentication request")?;
    Ok(())
}

/// An operation owns one single-use askpass endpoint until SSH exits.
pub(super) struct AskpassSession {
    endpoint: SocketAddr,
    token: Zeroizing<String>,
    task: tokio::task::JoinHandle<()>,
}

impl AskpassSession {
    async fn new(secret: Zeroizing<String>, authentication: String) -> Result<Self, String> {
        Self::with_lifetime(secret, authentication, AUTH_TIMEOUT).await
    }

    async fn with_lifetime(
        secret: Zeroizing<String>,
        authentication: String,
        lifetime: Duration,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Could not open the SSH authentication channel")?;
        let endpoint = listener
            .local_addr()
            .map_err(|_| "Could not inspect the SSH authentication channel")?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random)
            .map_err(|_| "Could not generate an SSH authentication token")?;
        let token = Zeroizing::new(hex::encode(random));
        random.zeroize();
        let server_token = token.clone();
        let task = tokio::spawn(async move {
            let serve = async {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let mut used = false;
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        answer_prompt(stream, &server_token, &authentication, &secret, &mut used),
                    )
                    .await;
                    if used {
                        return;
                    }
                }
            };
            let _ = tokio::time::timeout(lifetime, serve).await;
            drop(listener);
            drop(secret);
        });
        Ok(Self {
            endpoint,
            token,
            task,
        })
    }

    /// Configure only the ephemeral endpoint/token; the secret stays in memory.
    pub(super) fn configure(&self, command: &mut Command) -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|_| "Could not locate the SSH authentication helper")?;
        command
            .env("SSH_ASKPASS", executable)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "thunderbolt-ssh")
            .env(ENDPOINT_ENV, self.endpoint.to_string())
            .env(TOKEN_ENV, self.token.as_str());
        Ok(())
    }
}

impl Drop for AskpassSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Resolve a target-bound OS credential before allowing interactive SSH authentication.
pub(super) async fn prepare_askpass(
    connection: &SshConnection,
) -> Result<Option<AskpassSession>, String> {
    let connection = connection.clone();
    let authentication = connection.authentication.clone();
    let secret = tokio::time::timeout(
        AUTH_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            load_secret(&SystemCredentialStore, &connection)
        }),
    )
    .await
    .map_err(|_| "Unlock the system credential store and try again")?
    .map_err(|_| "Could not access the SSH credential store")??;
    match secret {
        Some(secret) => AskpassSession::new(secret, authentication).await.map(Some),
        None => Ok(None),
    }
}

fn request_secret(endpoint: &str, token: &str, prompt: &str) -> Result<Zeroizing<String>, String> {
    let endpoint: SocketAddr = endpoint
        .parse()
        .map_err(|_| "Invalid authentication endpoint")?;
    if endpoint.ip() != Ipv4Addr::LOCALHOST
        || token.len() != 64
        || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid authentication endpoint".into());
    }
    let mut stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(2))
        .map_err(|_| "SSH authentication expired")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "Could not configure authentication")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "Could not configure authentication")?;
    let request = AskpassRequest {
        token: token.into(),
        prompt: prompt.into(),
    };
    serde_json::to_writer(&mut stream, &request)
        .map_err(|_| "Could not request SSH authentication")?;
    stream
        .write_all(b"\n")
        .map_err(|_| "Could not request SSH authentication")?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| "Could not send SSH authentication request")?;
    let mut secret = Zeroizing::new(String::new());
    Read::take(stream, (MAX_SECRET_BYTES + 2) as u64)
        .read_to_string(&mut secret)
        .map_err(|_| "Could not receive SSH authentication")?;
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES + 1 || !secret.ends_with('\n') {
        return Err("SSH authentication was refused".into());
    }
    Ok(secret)
}

/// Run before initializing Tauri so OpenSSH can reuse this executable without a GUI.
pub fn run_ssh_askpass() -> Option<i32> {
    let endpoint = match std::env::var(ENDPOINT_ENV) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return None,
        Err(_) => return Some(1),
    };
    let answer = (|| -> Result<(), String> {
        let token =
            Zeroizing::new(std::env::var(TOKEN_ENV).map_err(|_| "Missing authentication token")?);
        let prompt = std::env::args()
            .nth(1)
            .ok_or("Missing authentication prompt")?;
        let secret = request_secret(&endpoint, &token, &prompt)?;
        std::io::stdout()
            .lock()
            .write_all(secret.as_bytes())
            .map_err(|_| "Could not answer SSH".into())
    })();
    Some(if answer.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryCredentialStore {
        fn read(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn write(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn remove(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    struct UnavailableCredentialStore;
    impl CredentialStore for UnavailableCredentialStore {
        fn read(&self, _: &str) -> Result<Option<String>, String> {
            Err("Credential store unavailable".into())
        }
        fn write(&self, _: &str, _: &str) -> Result<(), String> {
            Err("Credential store unavailable".into())
        }
        fn remove(&self, _: &str) -> Result<(), String> {
            Err("Credential store unavailable".into())
        }
    }

    fn connection() -> SshConnection {
        SshConnection {
            environment_id: "test-environment".into(),
            host: "test.example".into(),
            port: None,
            username: Some("test".into()),
            identity_file: None,
            authentication: "password".into(),
            has_secret: false,
        }
    }

    #[test]
    fn credentials_round_trip_update_and_delete_without_returning_to_frontend() {
        let store = MemoryCredentialStore::default();
        let target = connection();
        assert!(load_secret(&store, &target).is_err());
        save_secret(&store, target.clone(), Some("first".into())).unwrap();
        assert_eq!(
            load_secret(&store, &target).unwrap().unwrap().as_str(),
            "first"
        );
        save_secret(&store, target.clone(), Some("second".into())).unwrap();
        assert_eq!(
            load_secret(&store, &target).unwrap().unwrap().as_str(),
            "second"
        );
        save_secret(&store, target.clone(), None).unwrap();
        save_secret(&store, target.clone(), None).unwrap();
        assert!(load_secret(&store, &target).is_err());
    }

    #[test]
    fn changed_connection_cannot_reuse_a_saved_secret() {
        let store = MemoryCredentialStore::default();
        let target = connection();
        save_secret(&store, target.clone(), Some("private-value".into())).unwrap();
        for changed in [
            SshConnection {
                host: "other.example".into(),
                ..target.clone()
            },
            SshConnection {
                port: Some(2222),
                ..target.clone()
            },
            SshConnection {
                username: Some("other".into()),
                ..target.clone()
            },
            SshConnection {
                identity_file: Some("/a/key".into()),
                ..target.clone()
            },
            SshConnection {
                authentication: "key".into(),
                has_secret: true,
                ..target.clone()
            },
        ] {
            let error = load_secret(&store, &changed).unwrap_err();
            assert!(error.contains("connection changed"));
            assert!(!error.contains("private-value"));
        }
        let another = SshConnection {
            environment_id: "other-id".into(),
            ..target
        };
        assert!(load_secret(&store, &another).is_err());
    }

    #[test]
    fn agent_auth_never_reads_vault_and_unencrypted_key_needs_no_secret() {
        let store = MemoryCredentialStore::default();
        let agent = SshConnection {
            authentication: "agent".into(),
            ..connection()
        };
        assert!(load_secret(&store, &agent).unwrap().is_none());
        assert!(save_secret(&store, agent, Some("unused".into())).is_err());
        let key = SshConnection {
            authentication: "key".into(),
            identity_file: Some("/a/key".into()),
            ..connection()
        };
        assert!(load_secret(&store, &key).unwrap().is_none());
        save_secret(&store, key.clone(), Some("passphrase".into())).unwrap();
        let key = SshConnection {
            has_secret: true,
            ..key
        };
        assert_eq!(
            load_secret(&store, &key).unwrap().unwrap().as_str(),
            "passphrase"
        );
    }

    #[test]
    fn invalid_secrets_and_targets_never_reach_the_store() {
        let store = MemoryCredentialStore::default();
        for secret in [
            "".to_string(),
            "line\nbreak".into(),
            "nul\0byte".into(),
            "x".repeat(MAX_SECRET_BYTES + 1),
        ] {
            assert!(save_secret(&store, connection(), Some(secret)).is_err());
        }
        assert!(save_secret(
            &store,
            SshConnection {
                environment_id: "".into(),
                ..connection()
            },
            Some("secret".into())
        )
        .is_err());
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn unavailable_vault_fails_closed_without_blocking_auth_that_needs_no_secret() {
        let store = UnavailableCredentialStore;
        let target = connection();
        assert!(save_secret(&store, target.clone(), Some("secret".into())).is_err());
        assert!(load_secret(&store, &target).is_err());
        assert!(save_secret(&store, target.clone(), None).is_err());
        let agent = SshConnection {
            authentication: "agent".into(),
            ..target.clone()
        };
        assert!(load_secret(&store, &agent).unwrap().is_none());
        let key = SshConnection {
            authentication: "key".into(),
            identity_file: Some("/a/key".into()),
            ..target
        };
        assert!(load_secret(&store, &key).unwrap().is_none());
        assert!(load_secret(
            &store,
            &SshConnection {
                has_secret: true,
                ..key
            }
        )
        .is_err());
    }

    #[test]
    fn corrupt_vault_data_is_not_included_in_errors() {
        let store = MemoryCredentialStore::default();
        let target = connection();
        store
            .write(&target.environment_id, "corrupt-private-value")
            .unwrap();
        let error = load_secret(&store, &target).unwrap_err();
        assert_eq!(error, "Save the SSH credential again");
    }

    #[test]
    fn prompts_are_specific_to_auth_method_and_cannot_accept_host_keys_or_mfa() {
        assert!(accepts_prompt("password", "test@host's password: "));
        assert!(accepts_prompt("key", "Enter passphrase for key '/a/key': "));
        assert!(!accepts_prompt("key", "test@host's password: "));
        assert!(!accepts_prompt(
            "password",
            "Enter passphrase for key '/a/key': "
        ));
        assert!(!accepts_prompt(
            "password",
            "Are you sure you want to continue connecting (yes/no)?"
        ));
        assert!(!accepts_prompt("password", "Verification code: "));
        assert!(!accepts_prompt("password", "password: "));
        assert!(!accepts_prompt("agent", "test@host's password: "));
    }

    #[tokio::test]
    async fn askpass_requires_token_and_matching_prompt_and_is_single_use() {
        let session =
            AskpassSession::new(Zeroizing::new("correct-secret".into()), "password".into())
                .await
                .unwrap();
        for (token, prompt) in [
            ("0".repeat(64), "test@host's password:"),
            (session.token.to_string(), "Are you sure (yes/no)?"),
            (session.token.to_string(), "Verification code:"),
        ] {
            let endpoint = session.endpoint.to_string();
            assert!(
                tokio::task::spawn_blocking(move || request_secret(&endpoint, &token, prompt))
                    .await
                    .unwrap()
                    .is_err()
            );
        }
        let endpoint = session.endpoint.to_string();
        let token = session.token.to_string();
        let secret = tokio::task::spawn_blocking(move || {
            request_secret(&endpoint, &token, "test@host's password:")
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(secret.as_str(), "correct-secret\n");
        let endpoint = session.endpoint.to_string();
        let token = session.token.to_string();
        assert!(tokio::task::spawn_blocking(move || request_secret(
            &endpoint,
            &token,
            "test@host's password:"
        ))
        .await
        .unwrap()
        .is_err());
    }

    #[tokio::test]
    async fn dropping_session_closes_its_listener_and_configuration_contains_no_secret() {
        let session = AskpassSession::new(
            Zeroizing::new("must-not-be-in-environment".into()),
            "password".into(),
        )
        .await
        .unwrap();
        let endpoint = session.endpoint;
        let mut command = Command::new("ssh");
        session.configure(&mut command).unwrap();
        assert!(!format!("{command:?}").contains("must-not-be-in-environment"));
        assert!(format!("{command:?}").contains("SSH_ASKPASS_REQUIRE"));
        drop(session);
        tokio::time::timeout(Duration::from_secs(1), async {
            while tokio::net::TcpStream::connect(endpoint).await.is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the session must close its listener");
    }

    #[tokio::test]
    async fn unused_askpass_expires_and_drops_its_secret() {
        let mut session = AskpassSession::with_lifetime(
            Zeroizing::new("unused-secret".into()),
            "password".into(),
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        // Keep a connection to this listener so another parallel test reusing
        // its released port cannot be mistaken for a still-live credential channel.
        let mut peer = TcpStream::connect(session.endpoint).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), &mut session.task)
            .await
            .expect("unused authentication must expire")
            .expect("authentication listener must stop cleanly");
        let request = serde_json::to_vec(&AskpassRequest {
            token: session.token.to_string(),
            prompt: "test@host's password:".into(),
        })
        .unwrap();
        let _ = peer.write_all(&request);
        let _ = peer.write_all(b"\n");
        let mut received = [0; 64];
        match peer.read(&mut received) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                ) => {}
            result => panic!(
                "The expired credential channel must close without returning a secret: {result:?}"
            ),
        }
    }

    #[cfg(desktop)]
    #[test]
    fn pending_vault_access_rejects_other_operations_without_opening_the_store() {
        let access = lock_vault().unwrap();
        std::thread::spawn(|| {
            for result in [
                SystemCredentialStore.read("unused").map(|_| ()),
                SystemCredentialStore.write("unused", "must-not-be-stored"),
                SystemCredentialStore.remove("unused"),
            ] {
                assert!(result.unwrap_err().contains("credential store is busy"));
            }
        })
        .join()
        .unwrap();
        drop(access);
        assert!(lock_vault().is_ok());
    }

    #[cfg(desktop)]
    #[test]
    #[ignore = "uses a disposable OS-vault entry; run explicitly in the isolated CI vault"]
    fn system_vault_round_trip() {
        struct TestCredential(keyring::Entry);
        impl Drop for TestCredential {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let entry = TestCredential(
            system_entry(
                "net.thunderbird.thunderbolt.ssh-ci-test",
                &hex::encode(random),
            )
            .unwrap(),
        );
        assert!(matches!(
            entry.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        entry
            .0
            .set_password("disposable test credential 🔑")
            .unwrap();
        assert_eq!(
            entry.0.get_password().unwrap(),
            "disposable test credential 🔑"
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            entry.0.inner.get_attributes().unwrap()["persistence"],
            "Local"
        );
        entry
            .0
            .set_password("updated disposable credential")
            .unwrap();
        assert_eq!(
            entry.0.get_password().unwrap(),
            "updated disposable credential"
        );
        entry.0.delete_credential().unwrap();
        assert!(matches!(
            entry.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn helper_refuses_non_loopback_or_invalid_tokens() {
        assert!(request_secret("192.0.2.1:22", &"a".repeat(64), "test@host's password:").is_err());
        assert!(request_secret("127.0.0.1:22", "bad-token", "test@host's password:").is_err());
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Payload emitted to the frontend when the OAuth callback arrives.
#[derive(Clone, serde::Serialize)]
pub struct OAuthCallbackPayload {
    pub url: String,
}

const RESPONSE_HEADERS: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n";

/// Embed the shared logo so the one-shot callback page needs no asset requests.
fn completion_page() -> String {
    include_str!("oauth_complete.html")
        .replace("{{logo}}", include_str!("../../src/assets/logo.svg"))
}

/// Try to bind to one of the given ports in order. Returns the listener and the bound port.
/// Returns an error if none of the given ports are available — no silent fallback to a
/// random port, because OAuth providers reject redirect URIs on unregistered ports.
fn bind_to_port(ports: &[u16]) -> std::io::Result<(TcpListener, u16)> {
    for &port in ports {
        match TcpListener::bind(format!("127.0.0.1:{port}")) {
            Ok(listener) => {
                let bound_port = listener.local_addr()?.port();
                return Ok((listener, bound_port));
            }
            Err(_) => continue,
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AddrInUse,
        format!(
            "All OAuth loopback ports are in use ({ports:?}). Close any previous auth tabs and try again."
        ),
    ))
}

/// Accept only browser redirect GETs to this loopback listener, not arbitrary
/// Host headers (DNS rebinding), cross-origin fetches, or unrelated paths.
fn parse_request_path(raw: &str, port: u16) -> Option<&str> {
    let mut lines = raw.lines();
    let mut parts = lines.next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?;
    if !path.starts_with("/?") || parts.next()? != "HTTP/1.1" || parts.next().is_some() {
        return None;
    }
    let localhost = format!("localhost:{port}");
    let loopback = format!("127.0.0.1:{port}");
    let mut has_host = false;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if has_host || (value != localhost && value != loopback) {
                return None;
            }
            has_host = true;
        }
        if name.eq_ignore_ascii_case("origin")
            && value != format!("http://{localhost}")
            && value != format!("http://{loopback}")
        {
            return None;
        }
    }
    has_host.then_some(path)
}

/// An SSO listener consumes only its own nonce-bound callback, including IdP errors.
/// Other OAuth callers continue to validate their provider's state in the frontend.
fn matches_client_state(path: &str, port: u16, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Ok(url) = tauri::Url::parse(&format!("http://localhost:{port}{path}")) else {
        return false;
    };
    let mut states = url.query_pairs().filter(|(key, _)| key == "client_state");
    states.next().is_some_and(|(_, value)| value == expected) && states.next().is_none()
}

/// Cookies for other localhost ports can accompany the provider's redirect.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// Read a complete, bounded HTTP header, including requests split across TCP packets.
fn read_request(
    stream: &mut TcpStream,
    cancellation: &Cancellation,
    timeout: Duration,
) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .ok()?;
    let deadline = Instant::now() + timeout;
    let mut buffer = [0u8; MAX_REQUEST_BYTES];
    let mut length = 0;
    while !cancellation.is_cancelled() && Instant::now() < deadline && length < buffer.len() {
        match stream.read(&mut buffer[length..]) {
            Ok(0) => return None,
            Ok(count) => {
                length += count;
                if buffer[..length].windows(4).any(|part| part == b"\r\n\r\n") {
                    return String::from_utf8(buffer[..length].to_vec()).ok();
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return None,
        }
    }
    None
}

/// Five seconds beyond the frontend timeout; bounds abandoned native listeners too.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(305);
/// A local redirect sends its headers immediately; a stalled probe must yield the listener.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

static CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cancellation is keyed by the flow nonce, never the reusable loopback port.
struct Cancellation {
    flow_id: Option<String>,
    cancelled: Arc<AtomicBool>,
}

impl Cancellation {
    fn new(flow_id: Option<String>) -> Result<Self, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(id) = &flow_id {
            let mut pending = CANCELLATIONS.lock().unwrap();
            if pending.contains_key(id) {
                return Err("An OAuth listener already exists for this flow".to_string());
            }
            pending.insert(id.clone(), cancelled.clone());
        }
        Ok(Self { flow_id, cancelled })
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        if let Some(id) = &self.flow_id {
            CANCELLATIONS.lock().unwrap().remove(id);
        }
    }
}

/// Release a cancelled provider flow without disturbing another provider's listener.
pub fn stop(flow_id: &str) {
    if let Some(cancelled) = CANCELLATIONS.lock().unwrap().get(flow_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
}

/// Ignore unrelated connections until a valid callback arrives or the overall deadline expires.
fn receive_callback(
    mut connections: impl Iterator<Item = std::io::Result<TcpStream>>,
    port: u16,
    client_state: Option<&str>,
    cancellation: &Cancellation,
    timeout: Duration,
) -> Option<(TcpStream, String)> {
    let deadline = Instant::now() + timeout;
    let mut reported_accept_error = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || cancellation.is_cancelled() {
            return None;
        }
        let mut stream = match connections.next()? {
            Ok(stream) => stream,
            Err(error) => {
                // Aborted connections and resource exhaustion can recover. Retry within
                // the overall deadline, logging once so persistent errors cannot flood logs.
                if error.kind() != std::io::ErrorKind::WouldBlock && !reported_accept_error {
                    eprintln!("OAuth loopback accept failed; retrying until the callback deadline: {error}");
                    reported_accept_error = true;
                }
                thread::sleep(remaining.min(Duration::from_millis(50)));
                continue;
            }
        };
        let request = read_request(&mut stream, cancellation, remaining.min(REQUEST_TIMEOUT));
        if cancellation.is_cancelled() || Instant::now() >= deadline {
            return None;
        }
        stream.set_write_timeout(Some(Duration::from_secs(1))).ok();
        if let Some(path) = request
            .as_deref()
            .and_then(|raw| parse_request_path(raw, port))
            .filter(|path| matches_client_state(path, port, client_state))
        {
            return Some((stream, path.to_owned()));
        }
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }
}

/// Start a bounded loopback listener. Malformed probes never finish a flow; when
/// supplied, client_state must match before either success or error is emitted.
/// Frontend nonce/PKCE validation remains required for the corresponding OAuth flow.
pub fn start(
    app: tauri::AppHandle,
    ports: &[u16],
    flow_id: Option<String>,
    client_state: Option<String>,
) -> Result<u16, String> {
    let cancellation = Cancellation::new(flow_id)?;
    let (listener, port) = bind_to_port(ports).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    thread::spawn(move || {
        let Some((mut stream, path)) = receive_callback(
            listener.incoming(),
            port,
            client_state.as_deref(),
            &cancellation,
            ACCEPT_TIMEOUT,
        ) else {
            return;
        };
        let _ = stream.write_all(RESPONSE_HEADERS.as_bytes());
        let _ = stream.write_all(completion_page().as_bytes());
        let _ = stream.flush();
        if !cancellation.is_cancelled() {
            let url = format!("http://localhost:{port}{path}");
            let _ = app.emit("oauth-callback", OAuthCallbackPayload { url });
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Start the actual TCP receive loop without requiring a running Tauri application.
    fn spawn_receiver(
        state: Option<&str>,
        timeout: Duration,
    ) -> (u16, thread::JoinHandle<Option<String>>) {
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = state.map(str::to_owned);
        let handle = thread::spawn(move || {
            receive_callback(
                listener.incoming(),
                port,
                state.as_deref(),
                &Cancellation::new(None).unwrap(),
                timeout,
            )
            .map(|(_, path)| path)
        });
        (port, handle)
    }

    fn request(port: u16, path: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n")
    }

    /// Wait for rejection before sending the next probe so the test exercises each connection.
    fn send_rejected_request(port: u16, raw: &str) {
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client.write_all(raw.as_bytes()).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn parses_redirects_from_supported_loopback_hosts() {
        for host in ["localhost:17421", "127.0.0.1:17421"] {
            let raw = format!("GET /?code=abc&state=xyz HTTP/1.1\r\nHost: {host}\r\n\r\n");
            assert_eq!(
                parse_request_path(&raw, 17421),
                Some("/?code=abc&state=xyz")
            );
        }
    }

    #[test]
    fn rejects_malformed_or_unrelated_http_requests() {
        for raw in [
            "",
            "GET",
            "POST /?code=x HTTP/1.1\r\nHost: localhost:17421\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\nHost: localhost:17421\r\n\r\n",
            "GET /?code=x HTTP/1.1 extra\r\nHost: localhost:17421\r\n\r\n",
            "GET /?code=x HTTP/1.1\r\nHost: elsewhere.example\r\n\r\n",
            "GET /?code=x HTTP/1.1\r\nHost: localhost:17422\r\n\r\n",
            "GET /?code=x HTTP/1.1\r\nHost: localhost:17421\r\nHost: localhost:17421\r\n\r\n",
            "GET /?code=x HTTP/1.1\r\n\r\n",
        ] {
            assert_eq!(parse_request_path(raw, 17421), None, "{raw}");
        }
    }

    #[test]
    fn requires_one_exact_decoded_sso_state() {
        assert!(matches_client_state(
            "/?client_state=right&token=x",
            17421,
            Some("right")
        ));
        assert!(matches_client_state(
            "/?client_state=%72ight&token=x",
            17421,
            Some("right")
        ));
        for path in [
            "/?token=x",
            "/?client_state=&token=x",
            "/?client_state=wrong&token=x",
            "/?client_state=right&client_state=wrong&token=x",
            "/?client_state=right&%63lient_state=right&token=x",
        ] {
            assert!(!matches_client_state(path, 17421, Some("right")), "{path}");
        }
    }

    #[test]
    fn probes_and_invalid_states_do_not_consume_the_pending_sso_callback() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_secs(5));
        for raw in [
            String::new(),
            "not HTTP\r\n\r\n".to_string(),
            request(port, "/?token=unbound"),
            request(port, "/?error=access_denied"),
            request(port, "/?client_state=wrong&token=attacker"),
            request(
                port,
                "/?client_state=expected&client_state=wrong&token=attacker",
            ),
        ] {
            send_rejected_request(port, &raw);
        }
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // A fragmented TCP request must not consume the flow before all headers arrive.
        client
            .write_all(b"GET /?client_state=expected&token=real HTTP/1.1\r\n")
            .unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(150)))
            .unwrap();
        let error = client
            .read(&mut [0u8; 1])
            .expect_err("incomplete headers must keep waiting");
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        client
            .write_all(format!("Host: localhost:{port}\r\n\r\n").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?client_state=expected&token=real")
        );
    }

    #[test]
    fn accepts_a_legitimate_sso_error_with_matching_state() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_secs(2));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?client_state=expected&error=access_denied").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?client_state=expected&error=access_denied")
        );
    }

    #[test]
    fn accepts_cookie_heavy_redirects_up_to_the_header_limit() {
        for size in [12 * 1024, MAX_REQUEST_BYTES] {
            let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_secs(2));
            let prefix = format!(
                "GET /?client_state=expected&token=real HTTP/1.1\r\nHost: localhost:{port}\r\nCookie: local="
            );
            let raw = format!("{prefix}{}\r\n\r\n", "x".repeat(size - prefix.len() - 4));
            let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
            client.write_all(raw.as_bytes()).unwrap();
            assert_eq!(
                receiver.join().unwrap().as_deref(),
                Some("/?client_state=expected&token=real")
            );
        }
    }

    #[test]
    fn a_request_exceeding_the_header_budget_does_not_consume_the_callback() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_secs(2));
        let prefix = format!(
            "GET /?client_state=expected&token=real HTTP/1.1\r\nHost: localhost:{port}\r\nCookie: local="
        );
        // Exhaust the budget before the final header delimiter arrives.
        let raw = format!("{prefix}{}", "x".repeat(MAX_REQUEST_BYTES - prefix.len()));
        send_rejected_request(port, &raw);
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?client_state=expected&token=real").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?client_state=expected&token=real")
        );
    }

    #[test]
    fn accept_errors_do_not_consume_the_pending_callback() {
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let receiver = thread::spawn(move || {
            let errors = [
                std::io::ErrorKind::Interrupted,
                std::io::ErrorKind::ConnectionAborted,
                std::io::ErrorKind::Other,
            ]
            .into_iter()
            .map(|kind| Err(std::io::Error::from(kind)));
            receive_callback(
                errors.chain(listener.incoming()),
                port,
                Some("expected"),
                &Cancellation::new(None).unwrap(),
                Duration::from_secs(2),
            )
            .map(|(_, path)| path)
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?client_state=expected&token=real").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?client_state=expected&token=real")
        );
    }

    #[test]
    fn persistent_accept_errors_remain_bounded_by_the_deadline() {
        let errors = std::iter::repeat_with(|| {
            Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted))
        });
        let started = Instant::now();
        assert!(receive_callback(
            errors,
            17421,
            Some("expected"),
            &Cancellation::new(None).unwrap(),
            Duration::from_millis(100)
        )
        .is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn preserves_other_oauth_flows_without_an_sso_state_filter() {
        let (port, receiver) = spawn_receiver(None, Duration::from_secs(2));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?code=provider-code&state=provider-state").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?code=provider-code&state=provider-state")
        );
    }

    #[test]
    fn idle_timeout_releases_the_listener_port() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_millis(60));
        assert!(receiver.join().unwrap().is_none());
        assert!(bind_to_port(&[port]).is_ok());
    }

    #[test]
    fn overall_deadline_also_bounds_half_open_requests() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_millis(100));
        let _probe = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let started = Instant::now();
        assert!(receiver.join().unwrap().is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn repeated_rejections_do_not_extend_the_overall_deadline() {
        let timeout = Duration::from_millis(300);
        let (port, receiver) = spawn_receiver(Some("expected"), timeout);
        let started = Instant::now();
        let mut rejected = 0;
        while started.elapsed() < Duration::from_secs(2) {
            let Ok(mut client) = TcpStream::connect(("127.0.0.1", port)) else {
                break;
            };
            client
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            if client
                .write_all(request(port, "/?client_state=wrong&token=attacker").as_bytes())
                .is_err()
            {
                break;
            }
            let mut response = String::new();
            if client.read_to_string(&mut response).is_err() || response.is_empty() {
                break;
            }
            assert!(response.starts_with("HTTP/1.1 400"));
            rejected += 1;
        }
        assert!(receiver.join().unwrap().is_none());
        assert!(rejected >= 2);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(bind_to_port(&[port]).is_ok());
    }

    #[test]
    fn stalled_probe_yields_to_the_legitimate_callback() {
        let (port, receiver) = spawn_receiver(Some("expected"), Duration::from_secs(5));
        let _probe = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?client_state=expected&token=real").as_bytes())
            .unwrap();
        assert_eq!(
            receiver.join().unwrap().as_deref(),
            Some("/?client_state=expected&token=real")
        );
    }

    #[test]
    fn bind_to_port_returns_valid_port() {
        // Port 0 lets the OS assign a free port
        let (listener, port) = bind_to_port(&[0]).expect("should bind");
        assert!(port > 0);
        drop(listener);
    }

    #[test]
    fn bind_to_port_tries_next_on_conflict() {
        // Occupy a port, then verify the next port in the list is used
        let (first, first_port) = bind_to_port(&[0]).expect("should bind");
        let (second, second_port) =
            bind_to_port(&[first_port, 0]).expect("should bind to second port");
        assert_ne!(first_port, second_port);
        drop(first);
        drop(second);
    }

    #[test]
    fn bind_to_port_errors_when_all_ports_busy() {
        // Occupy a port, then try to bind ONLY to that port — should fail
        let (occupied, occupied_port) = bind_to_port(&[0]).expect("should bind");
        let result = bind_to_port(&[occupied_port]);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        drop(occupied);
    }
    #[test]
    fn cancellation_releases_port_and_does_not_cancel_other_flows() {
        let first = Cancellation::new(Some("cancelled-flow".into())).unwrap();
        let other = Cancellation::new(Some("other-flow".into())).unwrap();
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let thread = thread::spawn(move || {
            assert!(receive_callback(
                listener.incoming(),
                port,
                None,
                &first,
                Duration::from_secs(1)
            )
            .is_none());
        });
        stop("cancelled-flow");
        thread.join().unwrap();
        assert!(!other.is_cancelled());
        assert!(bind_to_port(&[port]).is_ok());
        assert!(!CANCELLATIONS.lock().unwrap().contains_key("cancelled-flow"));
    }

    #[test]
    fn legacy_listener_accepts_a_callback_without_a_flow_id() {
        let cancellation = Cancellation::new(None).unwrap();
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(request(port, "/?code=legacy").as_bytes())
            .unwrap();
        assert!(receive_callback(
            listener.incoming(),
            port,
            None,
            &cancellation,
            Duration::from_secs(1)
        )
        .is_some());
        drop(client);
    }

    #[test]
    fn idle_listener_times_out_without_a_callback() {
        let cancellation = Cancellation::new(None).unwrap();
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(receive_callback(
            listener.incoming(),
            port,
            None,
            &cancellation,
            Duration::ZERO
        )
        .is_none());
    }

    #[test]
    fn cancelled_flow_cannot_stop_a_later_listener() {
        let first = Cancellation::new(Some("finished-flow".into())).unwrap();
        drop(first);
        let next = Cancellation::new(Some("next-flow".into())).unwrap();
        stop("finished-flow");
        assert!(!next.is_cancelled());
    }

    #[test]
    fn duplicate_flow_does_not_replace_active_cancellation() {
        let first = Cancellation::new(Some("duplicate-flow".into())).unwrap();
        assert!(Cancellation::new(Some("duplicate-flow".into())).is_err());
        stop("duplicate-flow");
        assert!(first.is_cancelled());
    }

    #[test]
    fn validates_loopback_get_and_accepts_supported_browser_hosts() {
        for host in ["localhost:17421", "127.0.0.1:17421"] {
            let raw = format!("GET /?code=abc&state=xyz HTTP/1.1\r\nHost: {host}\r\n\r\n");
            assert_eq!(
                parse_request_path(&raw, 17421),
                Some("/?code=abc&state=xyz")
            );
        }
    }

    #[test]
    fn rejects_unrelated_requests_and_dns_rebinding_hosts() {
        for raw in [
            "GET /?token=spoof HTTP/1.1\r\nHost: evil.example\r\n\r\n",
            "GET /?token=spoof HTTP/1.1\r\nHost: localhost:17422\r\n\r\n",
            "GET /?token=spoof HTTP/1.1\r\nHost: localhost:17421\r\nHost: evil.example\r\n\r\n",
            "GET /?token=spoof HTTP/1.1\r\nHost: localhost:17421\r\nOrigin: https://evil.example\r\n\r\n",
            "POST /?token=spoof HTTP/1.1\r\nHost: localhost:17421\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\nHost: localhost:17421\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: localhost:17421\r\n\r\n",
            "GET /?token=spoof HTTP/1.1\r\n\r\n",
            "",
        ] {
            assert_eq!(parse_request_path(raw, 17421), None, "{raw}");
        }
    }

    #[test]
    fn cancelled_half_open_request_releases_port_promptly() {
        let cancellation = Cancellation::new(Some("half-open-flow".into())).unwrap();
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (accepted, wait_for_accept) = std::sync::mpsc::channel();
        let thread = thread::spawn(move || {
            listener.set_nonblocking(false).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            accepted.send(()).unwrap();
            assert!(read_request(&mut stream, &cancellation, Duration::from_secs(30)).is_none());
        });
        let _client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        wait_for_accept
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        thread::sleep(Duration::from_millis(150));
        let start = std::time::Instant::now();
        stop("half-open-flow");
        thread.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(bind_to_port(&[port]).is_ok());
    }

    #[test]
    fn invalid_requests_do_not_consume_the_pending_callback() {
        let cancellation = Cancellation::new(None).unwrap();
        let (listener, port) = bind_to_port(&[0]).unwrap();
        listener.set_nonblocking(true).unwrap();
        let thread = thread::spawn(move || {
            receive_callback(
                listener.incoming(),
                port,
                None,
                &cancellation,
                Duration::from_secs(3),
            )
            .unwrap()
            .1
        });
        for request in [
            "GET /?code=wrong HTTP/1.1\r\nHost: evil.example\r\n\r\n".to_string(),
            format!("POST /?code=wrong HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"),
        ] {
            let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            client.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 400"));
        }
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // TCP may split the request; the listener must read through the header terminator.
        client
            .write_all(b"GET /?code=real&state=nonce HTTP/1.1\r\n")
            .unwrap();
        client
            .write_all(format!("Host: localhost:{port}\r\n\r\n").as_bytes())
            .unwrap();
        assert_eq!(thread.join().unwrap(), "/?code=real&state=nonce");
    }

    #[test]
    fn completion_page_removes_credentials_from_browser_history() {
        assert!(completion_page().contains("history.replaceState(null, '', '/')"));
        assert!(RESPONSE_HEADERS.contains("Referrer-Policy: no-referrer"));
    }
}

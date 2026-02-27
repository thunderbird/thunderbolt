use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use tauri::Emitter;

/// Payload emitted to the frontend when the OAuth callback arrives.
#[derive(Clone, serde::Serialize)]
pub struct OAuthCallbackPayload {
    pub url: String,
}

const RESPONSE_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html>\
<head><title>Thunderbolt</title></head>\
<body style=\"font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5\">\
<div style=\"text-align:center;padding:2rem\">\
<h2>Authentication Complete</h2>\
<p>You can close this tab and return to Thunderbolt.</p>\
</div>\
</body>\
</html>";

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

/// Extract the request path + query string from the first line of an HTTP request.
///
/// Input: `"GET /callback?code=xxx&state=yyy HTTP/1.1\r\n..."`
/// Output: `"/callback?code=xxx&state=yyy"`
fn parse_request_path(raw: &str) -> Option<&str> {
    let first_line = raw.lines().next()?;
    let mut parts = first_line.splitn(3, ' ');
    parts.next(); // skip method
    parts.next() // return path
}

/// Start the in-house OAuth loopback server. Returns the port it bound to.
///
/// The server:
/// 1. Binds to `127.0.0.1` on one of the given ports (or OS-assigned port 0 as fallback)
/// 2. Spawns a `std::thread` that accepts **one** connection
/// 3. Reads the HTTP GET request, sends the "Authentication Complete" HTML page
/// 4. Emits `"oauth-callback"` to the Tauri frontend with the full callback URL
/// 5. The thread exits — the `TcpListener` drops and the port is released
///
/// No async runtime is required. No external HTTP framework is used.
///
/// # Security
///
/// The server accepts the first connection on the loopback port without validating
/// the caller. A local process could theoretically race to connect before the browser
/// redirect arrives. This is a known and accepted risk for all loopback OAuth flows
/// (RFC 8252 §8.3). PKCE prevents token theft: the attacker cannot exchange the code
/// without the code verifier, which never leaves the frontend.
pub fn start(app: tauri::AppHandle, ports: &[u16]) -> Result<u16, String> {
    let (listener, port) = bind_to_port(ports).map_err(|e| e.to_string())?;

    thread::spawn(move || {
        // Accept exactly one connection — then the thread exits
        let Ok((mut stream, _addr)) = listener.accept() else {
            return;
        };

        // 4 KB is more than enough for an OAuth redirect request
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);

        // Send the "Authentication Complete" page and close the connection
        let _ = stream.write_all(RESPONSE_HTML.as_bytes());
        let _ = stream.flush();
        drop(stream);

        // Build the full callback URL and emit it to the frontend
        if let Some(path) = parse_request_path(&request) {
            let url = format!("http://localhost:{port}{path}");
            let _ = app.emit("oauth-callback", OAuthCallbackPayload { url });
        } else {
            // Bare TCP probe, zero-byte read, or malformed request — emit an error
            // so the frontend surfaces it immediately instead of waiting for the 5-min timeout
            let url = format!("http://localhost:{port}/?error=invalid_request&error_description=Received+unparseable+connection+on+OAuth+loopback+port");
            let _ = app.emit("oauth-callback", OAuthCallbackPayload { url });
        }

        // listener drops here — port is released
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request_path_extracts_path_and_query() {
        let raw = "GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(
            parse_request_path(raw),
            Some("/callback?code=abc&state=xyz")
        );
    }

    #[test]
    fn parse_request_path_handles_root() {
        let raw = "GET / HTTP/1.1\r\n";
        assert_eq!(parse_request_path(raw), Some("/"));
    }

    #[test]
    fn parse_request_path_returns_none_on_empty() {
        assert_eq!(parse_request_path(""), None);
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
}

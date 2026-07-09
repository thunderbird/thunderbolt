/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Thunderbolt ACP client — a relay-only [iroh] dialer compiled to WebAssembly.
//!
//! The web app can't open UDP sockets, so this crate binds a **relay-only**
//! iroh endpoint (the n0 preset): every QUIC packet flows over a WebSocket to an
//! n0 relay, still end-to-end encrypted to the dialed peer. That is exactly the
//! topology of dialing a `thunderbolt acp --transport iroh` CLI bridge from the
//! browser — no hole-punching, no direct path.
//!
//! Surface (consumed by `src/acp/transports/iroh.ts`):
//!   * [`IrohClient::create`] — bind ONE long-lived endpoint (optionally pinned
//!     to a persisted secret key so the bridge operator allowlists a stable
//!     NodeId once, and optionally pointed at a self-hosted relay instead of the
//!     n0 public ones).
//!   * [`IrohClient::connect`] — dial a ticket or bare NodeId over an ALPN and
//!     open ONE bidirectional stream, returning an [`IrohConnection`].
//!   * [`IrohConnection::send`] / [`IrohConnection::readable`] — write bytes into
//!     and read bytes out of that stream. The JS side carries newline-delimited
//!     JSON-RPC (ACP) over this raw byte pipe, matching the CLI bridge's ndjson
//!     framing (`cli/src/iroh/pump.ts`).
//!
//! The ALPN is supplied by the caller (`thunderbolt/acp/0` for the ACP bridge)
//! and must match the bridge byte-for-byte or the QUIC handshake is refused.
//!
//! This same crate is intended to be the shared native client for Tauri
//! (desktop/mobile) via its `rlib` target; only the wasm/web target is built
//! here — native embedding is deferred.

use std::cell::RefCell;

use async_channel::{Receiver, Sender};
use futures_channel::oneshot;
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use js_sys::{Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, spawn_local};
use wasm_streams::ReadableStream;
use wasm_streams::readable::sys::ReadableStream as JsReadableStream;

/// Depth of the outbound byte queue. Keeps `send()` decoupled from the QUIC write
/// task — the frame is handed off over the channel rather than written under a
/// borrow of the wasm-bindgen object, so `self` is never held across an await —
/// while bounding how many frames may be in flight. Small because ACP JSON-RPC
/// messages are tiny and frequent.
const OUTBOUND_CAPACITY: usize = 64;

/// A queued outbound frame: the bytes to write, paired with a `oneshot` the write
/// task fulfils once those bytes are written (`Ok`) or a write fails (`Err(msg)`).
/// This is how `send()`'s promise reflects the ACTUAL write outcome instead of
/// merely that the frame was buffered — no accepted frame is ever silently dropped.
type OutboundFrame = (Vec<u8>, oneshot::Sender<Result<(), String>>);

/// Max bytes pulled per recv read — a comfortably large ceiling for JSON-RPC.
const READ_CHUNK_LIMIT: usize = 1 << 16;

/// Installs a panic hook that surfaces Rust panics as readable console errors.
#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// One long-lived relay-only iroh endpoint. Hold a single instance for the app's
/// lifetime and open a connection per bridge — re-binding per dial would churn
/// the relay handshake and the NodeId.
#[wasm_bindgen]
pub struct IrohClient {
    endpoint: Endpoint,
    secret_key_hex: String,
}

#[wasm_bindgen]
impl IrohClient {
    /// Bind the relay-only endpoint. Returns as soon as the endpoint is bound;
    /// the home relay is warmed lazily by the first [`IrohClient::connect`].
    ///
    /// We deliberately do NOT pre-warm the relay here (no `endpoint.online()`):
    /// that call has no timeout, so on an offline or captive network it pends
    /// forever, and the JS side caches this future in an app-wide singleton — a
    /// never-resolving bind would poison every later dial. `connect()` resolves
    /// the relay path on demand instead, and the JS transport bounds that dial
    /// with its `AbortSignal`. `bind()` itself does not block on connectivity.
    ///
    /// Pass a 32-byte hex secret key to pin a stable NodeId (so the bridge
    /// operator runs `thunderbolt iroh allow <node-id>` only once); pass `null`
    /// to generate a fresh identity, then read it back via
    /// [`IrohClient::secret_key_hex`] to persist for next session.
    ///
    /// `relay_url` overrides the relay: `None`/empty keeps the n0 preset's public
    /// relays (today's behavior); a self-hosted iroh-relay URL swaps ONLY the
    /// relay, leaving the n0 DNS discovery + crypto from `presets::N0` intact so a
    /// bare NodeId still resolves and tickets still dial. The web app threads
    /// `VITE_IROH_RELAY_URL` through here.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        secret_key_hex: Option<String>,
        relay_url: Option<String>,
    ) -> Result<IrohClient, JsError> {
        let secret = match secret_key_hex.as_deref() {
            Some(hex) if !hex.trim().is_empty() => parse_secret(hex)?,
            _ => SecretKey::generate(),
        };
        let stored_hex = hex::encode(secret.to_bytes());
        let mut builder = Endpoint::builder(presets::N0).secret_key(secret);
        if let Some(url) = relay_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            let relay: RelayUrl = url.parse().map_err(to_js)?;
            builder = builder.relay_mode(RelayMode::custom([relay]));
        }
        let endpoint = builder.bind().await.map_err(to_js)?;
        Ok(IrohClient {
            endpoint,
            secret_key_hex: stored_hex,
        })
    }

    /// This client's NodeId (base32). The bridge operator allowlists it with
    /// `thunderbolt iroh allow <node-id>`.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// This client's secret key as hex, so the app can persist it and re-create
    /// the SAME NodeId next session.
    #[wasm_bindgen(js_name = secretKeyHex)]
    pub fn secret_key_hex(&self) -> String {
        self.secret_key_hex.clone()
    }

    /// Dial `target` (an `EndpointTicket` or a bare NodeId) over `alpn`, open ONE
    /// bidirectional stream, and resolve to an [`IrohConnection`].
    ///
    /// Returns a `Promise` (rather than an `async fn` borrowing `&self`) so the
    /// endpoint is cloned out synchronously and the future owns it.
    #[wasm_bindgen(js_name = connect)]
    pub fn connect(&self, target: String, alpn: String) -> Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            let addr = resolve_target(&target)?;
            let connection = endpoint
                .connect(addr, alpn.as_bytes())
                .await
                .map_err(err_to_jsv)?;
            let (send, recv) = connection.open_bi().await.map_err(err_to_jsv)?;
            Ok(JsValue::from(IrohConnection::new(connection, send, recv)))
        })
    }
}

/// A live bridge connection: one QUIC bidi stream over the relay. Sending queues
/// bytes for the write task; the receive half is exposed once as a JS
/// `ReadableStream` of `Uint8Array` chunks.
#[wasm_bindgen]
pub struct IrohConnection {
    // Held to keep the QUIC connection alive — dropping it tears the stream down.
    connection: Connection,
    outbound: Sender<OutboundFrame>,
    readable: RefCell<Option<JsReadableStream>>,
}

impl IrohConnection {
    fn new(connection: Connection, send: SendStream, recv: RecvStream) -> Self {
        let (outbound, rx) = async_channel::bounded::<OutboundFrame>(OUTBOUND_CAPACITY);
        spawn_local(drive_send(send, rx));
        let readable = ReadableStream::from_stream(recv_byte_stream(recv)).into_raw();
        IrohConnection {
            connection,
            outbound,
            readable: RefCell::new(Some(readable)),
        }
    }
}

#[wasm_bindgen]
impl IrohConnection {
    /// Write `data` to the bidi stream, resolving only once the bytes are ACTUALLY
    /// written and rejecting if the write fails — the promise reflects the real
    /// write outcome, never merely that the frame was buffered. The frame is
    /// handed to the write task over the bounded queue (so `self` is never held
    /// across an await and backpressure is preserved), carrying a `oneshot` the
    /// task fulfils once the write settles. Rejects if the connection is already
    /// closed, or if the write task tears down before this frame is written — so
    /// an accepted frame is never silently dropped.
    #[wasm_bindgen(js_name = send)]
    pub fn send(&self, data: Vec<u8>) -> Promise {
        let outbound = self.outbound.clone();
        future_to_promise(async move {
            let (done_tx, done_rx) = oneshot::channel();
            outbound
                .send((data, done_tx))
                .await
                .map_err(|_| JsValue::from(JsError::new("iroh connection closed")))?;
            match done_rx.await {
                Ok(Ok(())) => Ok(JsValue::UNDEFINED),
                Ok(Err(msg)) => Err(JsValue::from(JsError::new(&msg))),
                // The write task dropped this frame's sender without writing it
                // (it broke out on an earlier write error) — surface it, don't drop.
                Err(_canceled) => Err(JsValue::from(JsError::new("iroh connection closed"))),
            }
        })
    }

    /// The receive half as a `ReadableStream<Uint8Array>`. Consumed once — the JS
    /// transport reads it for the lifetime of the session.
    #[wasm_bindgen(js_name = readable)]
    pub fn readable(&self) -> Result<JsReadableStream, JsError> {
        self.readable
            .borrow_mut()
            .take()
            .ok_or_else(|| JsError::new("iroh receive stream already taken"))
    }

    /// Close the connection: stop the outbound queue (finishing the send half)
    /// and close the QUIC connection.
    #[wasm_bindgen(js_name = close)]
    pub fn close(&self) {
        self.outbound.close();
        self.connection.close(0u8.into(), b"client closed");
    }
}

/// Drain the outbound queue into the send half, finishing the stream when the
/// queue closes (on [`IrohConnection::close`] or drop) or a write fails. Each
/// frame's `oneshot` is fulfilled with the write outcome so its `send()` promise
/// settles truthfully; on a write error every still-queued frame is failed too,
/// so no accepted frame's promise is left resolving `Ok` on bytes that never
/// reached the wire.
async fn drive_send(mut send: SendStream, rx: Receiver<OutboundFrame>) {
    while let Ok((chunk, done)) = rx.recv().await {
        match send.write_all(&chunk).await {
            Ok(()) => {
                let _ = done.send(Ok(()));
            }
            Err(err) => {
                let msg = err.to_string();
                let _ = done.send(Err(msg.clone()));
                // Fail every frame already accepted into the queue rather than
                // dropping it silently; frames that race in after this drop their
                // sender and reject via the `Canceled` arm in `send()`.
                while let Ok((_, queued)) = rx.try_recv() {
                    let _ = queued.send(Err(msg.clone()));
                }
                break;
            }
        }
    }
    let _ = send.finish();
}

/// Turn the iroh recv half into a `Stream` of `Uint8Array` chunks for
/// `ReadableStream::from_stream`. Ends on a clean FIN (`Ok(None)`); a read error
/// is surfaced as a stream error and ends the stream.
fn recv_byte_stream(
    mut recv: RecvStream,
) -> impl futures_core::Stream<Item = Result<JsValue, JsValue>> {
    async_stream::stream! {
        loop {
            match recv.read_chunk(READ_CHUNK_LIMIT).await {
                Ok(Some(bytes)) => {
                    let chunk = Uint8Array::new_with_length(bytes.len() as u32);
                    chunk.copy_from(bytes.as_ref());
                    yield Ok(JsValue::from(chunk));
                }
                Ok(None) => break,
                Err(err) => {
                    yield Err(JsValue::from(JsError::new(&err.to_string())));
                    break;
                }
            }
        }
    }
}

/// Resolve a dial target: an `EndpointTicket` (NodeId + relay URL) if it parses,
/// else a bare NodeId relying on n0 DNS discovery to find the relay.
fn resolve_target(target: &str) -> Result<EndpointAddr, JsValue> {
    if let Ok(ticket) = target.parse::<EndpointTicket>() {
        return Ok(ticket.endpoint_addr().clone());
    }
    let id: EndpointId = target.parse().map_err(err_to_jsv)?;
    Ok(EndpointAddr::from(id))
}

/// Parse a 32-byte hex secret key into a [`SecretKey`].
fn parse_secret(hex_str: &str) -> Result<SecretKey, JsError> {
    let bytes = hex::decode(hex_str.trim()).map_err(to_js)?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| JsError::new("secret key must be 32 bytes (64 hex chars)"))?;
    Ok(SecretKey::from_bytes(&arr))
}

fn to_js(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}

fn err_to_jsv(err: impl std::fmt::Display) -> JsValue {
    JsValue::from(JsError::new(&err.to_string()))
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Structural seams for the wasm iroh client (`crates/thunderbolt-acp-client`).
 *
 * The generated `pkg/*.d.ts` types are wasm-bindgen flavoured (`Promise<any>`,
 * raw `ReadableStream`), so the transport speaks to these narrow structural
 * shapes instead. That keeps the transport's framing logic unit-testable with a
 * fake client — without instantiating the multi-MB wasm or binding a real
 * relay endpoint.
 */

/** One open bridge connection: a single QUIC bidi stream over the relay. */
export type IrohConnectionLike = {
  /** Write bytes to the send half; resolves once they are actually written and
   *  rejects if the write fails (or the connection is closed). */
  send: (data: Uint8Array) => Promise<unknown>
  /** The receive half as a byte stream — consumed once. */
  readable: () => ReadableStream<Uint8Array>
  /** Close the connection (finishes the send half, closes QUIC). */
  close: () => void
}

/** The long-lived relay endpoint. One instance backs every iroh transport. */
export type IrohClientLike = {
  /** This client's NodeId (base32) — what a bridge operator allowlists. */
  nodeId: () => string
  /** Dial a ticket or bare NodeId over `alpn`, opening one bidi stream. */
  connect: (target: string, alpn: string) => Promise<IrohConnectionLike>
}

/** Loads (and binds) the shared iroh client. Production dynamic-imports the wasm
 *  chunk; tests inject a fake. */
export type IrohClientLoader = () => Promise<IrohClientLike>

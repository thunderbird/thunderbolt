/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * One long-lived relay-only iroh endpoint. Hold a single instance for the app's
 * lifetime and open a connection per bridge — re-binding per dial would churn
 * the relay handshake and the NodeId.
 */
export class IrohClient {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Dial `target` (an `EndpointTicket` or a bare NodeId) over `alpn`, open ONE
     * bidirectional stream, and resolve to an [`IrohConnection`].
     *
     * Returns a `Promise` (rather than an `async fn` borrowing `&self`) so the
     * endpoint is cloned out synchronously and the future owns it.
     */
    connect(target: string, alpn: string): Promise<any>;
    /**
     * Bind the relay-only endpoint. Returns as soon as the endpoint is bound;
     * the home relay is warmed lazily by the first [`IrohClient::connect`].
     *
     * We deliberately do NOT pre-warm the relay here (no `endpoint.online()`):
     * that call has no timeout, so on an offline or captive network it pends
     * forever, and the JS side caches this future in an app-wide singleton — a
     * never-resolving bind would poison every later dial. `connect()` resolves
     * the relay path on demand instead, and the JS transport bounds that dial
     * with its `AbortSignal`. `bind()` itself does not block on connectivity.
     *
     * Pass a 32-byte hex secret key to pin a stable NodeId (so the bridge
     * operator runs `thunderbolt iroh allow <node-id>` only once); pass `null`
     * to generate a fresh identity, then read it back via
     * [`IrohClient::secret_key_hex`] to persist for next session.
     */
    static create(secret_key_hex?: string | null): Promise<IrohClient>;
    /**
     * This client's NodeId (base32). The bridge operator allowlists it with
     * `thunderbolt iroh allow <node-id>`.
     */
    nodeId(): string;
    /**
     * This client's secret key as hex, so the app can persist it and re-create
     * the SAME NodeId next session.
     */
    secretKeyHex(): string;
}

/**
 * A live bridge connection: one QUIC bidi stream over the relay. Sending queues
 * bytes for the write task; the receive half is exposed once as a JS
 * `ReadableStream` of `Uint8Array` chunks.
 */
export class IrohConnection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Close the connection: stop the outbound queue (finishing the send half)
     * and close the QUIC connection.
     */
    close(): void;
    /**
     * The receive half as a `ReadableStream<Uint8Array>`. Consumed once — the JS
     * transport reads it for the lifetime of the session.
     */
    readable(): ReadableStream;
    /**
     * Queue `data` to be written to the bidi stream. Resolves once enqueued
     * (the write task drains it); rejects if the connection is already closed.
     */
    send(data: Uint8Array): Promise<any>;
}

/**
 * Installs a panic hook that surfaces Rust panics as readable console errors.
 */
export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_irohclient_free: (a: number, b: number) => void;
    readonly __wbg_irohconnection_free: (a: number, b: number) => void;
    readonly irohclient_connect: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly irohclient_create: (a: number, b: number) => number;
    readonly irohclient_nodeId: (a: number, b: number) => void;
    readonly irohclient_secretKeyHex: (a: number, b: number) => void;
    readonly irohconnection_close: (a: number) => void;
    readonly irohconnection_readable: (a: number, b: number) => void;
    readonly irohconnection_send: (a: number, b: number, c: number) => number;
    readonly start: () => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wasm_bindgen_func_elem_16108: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_16092: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_5272: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2949: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_7132: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5103: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6256: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6390: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_14776: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

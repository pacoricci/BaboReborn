// Request, connection and clock timing in browser monotonic milliseconds.
export const REQUEST_TIMEOUT_MS = 8000;
export const PROOF_REFRESH_MARGIN_MS = 5 * 60_000; // Renew before an access proof expires.
export const PROOF_RENEWAL_INTERVAL_MS = 30_000;
export const PROBE_INTERVAL_MS = 1000;
export const RECEIPT_FLUSH_MS = 25;
export const SEND_STALL_LIMIT_MS = 5000; // Sustained backpressure closes the connection.
export const CLOCK_MAX_RTT_MS = 5000; // Slower probes are not clock evidence.
export const CLOCK_SAMPLE_REFRESH_MS = 10_000; // A wider but fresher sample replaces an older one.
export const CLOCK_SAMPLE_EXPIRY_MS = 30_000; // Older samples no longer bound authority time.

import { authentication, maintainProof, onProof, watchAccount } from './identity';
// Browser WebSocket adapter. The application owns session transitions and presentation.
import { CLOSE, CLOSE_REASON, PROTOCOL } from '../contracts/session';
import type { ClientMessage, Delivery, Receipt, AuthorityTime } from '../contracts/session';
import { parseDelivery } from './protocol';
import { AuthorityClock } from './clock';
import { payloadBytes } from './payload';
import {
  CLOCK_MAX_RTT_MS,
  PROBE_INTERVAL_MS,
  PROOF_RENEWAL_INTERVAL_MS,
  RECEIPT_FLUSH_MS,
  SEND_STALL_LIMIT_MS,
} from './timing';

interface ConnectionHandlers {
  diagnosticsEnabled?(): boolean;
  diagnostic?(
    kind: 'probe' | 'backpressure' | 'resync' | 'delivery' | 'receipt',
    now: number,
    data: Record<string, string | number | boolean | null>,
  ): void;
  message(message: Delivery, now: number, time: AuthorityTime): void;
  closed(code: number, reason: string): void;
  invalid(error: unknown): void;
  error(): void;
}
export class Connection {
  private readonly socket: WebSocket;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly stopProof: () => void;
  private readonly stopAccount: () => void;
  private readonly renewal: ReturnType<typeof setInterval>;
  private authenticated = false;
  private readonly clock = new AuthorityClock();
  private generation = 0;
  private receipt: Receipt | undefined;
  private readonly receiptTimer: ReturnType<typeof setInterval>;
  private blockedSince: number | undefined;
  private recovery = false;
  private probeNonce = -1;
  private stopped = false;

  payloadBytesIn = 0;
  payloadBytesOut = 0;
  get webSocketExtensions(): string {
    return this.socket.extensions;
  }
  get rtt(): number {
    return this.clock.rtt;
  }
  constructor(
    url: URL,
    private handlers: ConnectionHandlers,
  ) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.stopAccount = watchAccount(() =>
      this.close(CLOSE.rejected, CLOSE_REASON.authenticationExpired),
    );
    this.stopProof = onProof((proof) => {
      if (this.connected) this.write({ type: 'authenticate', proof });
    });
    this.socket.addEventListener('open', () => {
      void authentication()
        .then((auth) => {
          if (this.socket.readyState === WebSocket.OPEN) {
            this.write({ type: 'authenticate', ...auth });
            this.authenticated = true;
            this.probe();
          }
        })
        .catch(() => this.close(CLOSE.rejected, CLOSE_REASON.authenticationExpired));
    });
    this.renewal = setInterval(() => {
      void maintainProof().catch(() =>
        this.close(CLOSE.rejected, CLOSE_REASON.authenticationExpired),
      );
    }, PROOF_RENEWAL_INTERVAL_MS);
    this.heartbeat = setInterval(() => this.probe(), PROBE_INTERVAL_MS);
    this.receiptTimer = setInterval(() => this.flush(), RECEIPT_FLUSH_MS);
    this.socket.addEventListener('message', (event) => {
      try {
        const now = performance.now();
        const collecting = handlers.diagnosticsEnabled?.() === true;
        const message = parseDelivery(event.data);
        const parsedAt = collecting ? performance.now() : now;
        if (collecting) this.payloadBytesIn += payloadBytes(event.data as string | ArrayBuffer);

        if (message.kind === 'probe' && message.body.nonce === this.probeNonce) {
          this.clock.observe(message.body.nonce, now, message.body.receivedAtMs, message.sentAtMs);
          if (collecting) {
            const measuredRtt =
              now - message.body.nonce - (message.sentAtMs - message.body.receivedAtMs);
            handlers.diagnostic?.('probe', now, {
              rttMs: measuredRtt >= 0 && measuredRtt <= CLOCK_MAX_RTT_MS ? measuredRtt : null,
              parseMs: parsedAt - now,
              clientSentAtMs: message.body.nonce,
              serverReceivedAtMs: message.body.receivedAtMs,
              serverSelectedAtMs: message.sentAtMs,
              ...this.clock.diagnostics(now),
            });
          }
        }
        const processingAt = collecting ? performance.now() : now;
        handlers.message(message, now, this.clock.time(now));
        if (collecting && (message.kind === 'state' || message.kind === 'installation')) {
          const processedAtMs = performance.now();
          handlers.diagnostic?.('delivery', processedAtMs, {
            connection: message.connection,
            generation: message.generation,
            sequence: message.sequence,
            receivedAtMs: now,
            parseMs: parsedAt - now,
            processingMs: processedAtMs - processingAt,
            processedAtMs,
          });
        }
      } catch (error) {
        handlers.invalid(error);
        // Browser WebSocket.close only accepts 1000 or application codes 3000..4999.
        this.close(CLOSE.rejected, 'Invalid server message');
      }
    });
    this.socket.addEventListener('close', (event) => {
      this.stop();
      handlers.closed(event.code, event.reason);
    });
    this.socket.addEventListener('error', () => handlers.error());
  }
  get connected(): boolean {
    return !this.stopped && this.authenticated && this.socket.readyState === WebSocket.OPEN;
  }
  private write(message: object): void {
    const data = JSON.stringify({ ...message, version: PROTOCOL });
    if (this.handlers.diagnosticsEnabled?.()) this.payloadBytesOut += payloadBytes(data);
    this.socket.send(data);
  }
  private available(): boolean {
    if (!this.connected) return false;
    const now = performance.now();
    if (this.socket.bufferedAmount > 16384) {
      if (this.blockedSince === undefined && this.handlers.diagnosticsEnabled?.())
        this.handlers.diagnostic?.('backpressure', now, {
          blocked: true,
          bufferedAmount: this.socket.bufferedAmount,
        });
      this.blockedSince ??= now;
      this.recovery = true;
      if (now - this.blockedSince >= SEND_STALL_LIMIT_MS)
        this.close(CLOSE.removed, 'input_delivery_stalled');
      return false;
    }
    if (this.blockedSince !== undefined && this.handlers.diagnosticsEnabled?.())
      this.handlers.diagnostic?.('backpressure', now, {
        blocked: false,
        durationMs: now - this.blockedSince,
        bufferedAmount: this.socket.bufferedAmount,
      });
    this.blockedSince = undefined;
    return true;
  }
  private flush(): void {
    if (!this.available()) return;
    if (this.receipt) {
      this.write({ type: 'receipt', receipt: this.receipt });
      if (this.handlers.diagnosticsEnabled?.())
        this.handlers.diagnostic?.('receipt', performance.now(), {
          ...this.receipt,
          bufferedAmount: this.socket.bufferedAmount,
        });
      this.receipt = undefined;
    }
    if (this.recovery && this.generation) {
      if (this.handlers.diagnosticsEnabled?.())
        this.handlers.diagnostic?.('resync', performance.now(), {
          reason: 'outbound_backpressure',
          generation: this.generation,
        });
      this.write({ type: 'resync', generation: this.generation });
      this.recovery = false;
    }
  }
  private probe(): void {
    if (!this.available()) return;
    this.probeNonce = performance.now();
    this.write({ type: 'ping', nonce: this.probeNonce });
  }
  send(message: ClientMessage): void {
    if (message.type === 'receipt') {
      this.receipt = message.receipt;
      this.generation = message.receipt.generation;
      if (message.immediate) this.flush();
      return;
    }
    if (!this.available()) return;
    this.flush();
    if (this.generation) this.write({ ...message, generation: this.generation });
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.receiptTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.renewal);
    this.stopProof();
    this.stopAccount();
    this.receipt = undefined;
  }
  close(code = 1000, reason = ''): void {
    if (this.stopped) return;
    this.stop();
    this.socket.close(code, reason);
  }
}

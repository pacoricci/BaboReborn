import type { AuthorityTime } from '../contracts/session';
import { CLOCK_MAX_RTT_MS, CLOCK_SAMPLE_EXPIRY_MS, CLOCK_SAMPLE_REFRESH_MS } from './timing';

// Four timestamps bound the clock offset without assuming symmetric latency.
// The upper bound governs expiring presentation; the midpoint drives prediction.
export class AuthorityClock {
  private sample: { low: number; high: number; at: number } | undefined;
  rtt = 0;
  observe(sent: number, received: number, serverReceived: number, serverSent: number): void {
    const network = received - sent - (serverSent - serverReceived);
    if (network < 0 || network > CLOCK_MAX_RTT_MS) return;
    this.rtt = network;
    const low = serverSent - received,
      high = serverReceived - sent;
    const old = this.sample;
    if (!old || received - old.at > CLOCK_SAMPLE_REFRESH_MS || high - low <= old.high - old.low)
      this.sample = { low, high, at: received };
  }
  time(now: number): AuthorityTime {
    const s = this.sample;
    if (!s || now - s.at > CLOCK_SAMPLE_EXPIRY_MS) return { now: Infinity, upper: Infinity };
    const drift = Math.max(0, now - s.at) * 0.001;
    return { now: now + (s.low + s.high) / 2, upper: now + s.high + drift };
  }
  diagnostics(now: number) {
    const s = this.sample;
    const valid = s && now - s.at <= CLOCK_SAMPLE_EXPIRY_MS;
    const drift = valid ? Math.max(0, now - s.at) * 0.001 : 0;
    return {
      offsetLowMs: valid ? s.low - drift : null,
      offsetHighMs: valid ? s.high + drift : null,
      clockSampleAtMs: valid ? s.at : null,
    };
  }
}

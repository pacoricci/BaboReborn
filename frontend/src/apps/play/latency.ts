const REFRESH_MS = 15_000;
const PROBE_TIMEOUT_MS = 5000;

export function measureLatency(origin: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const address = new URL(origin);
    const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
    if (
      address.origin !== origin ||
      (address.protocol !== 'https:' &&
        !(
          address.protocol === 'http:' &&
          loopback(address.hostname) &&
          loopback(location.hostname)
        ))
    )
      throw new Error('Invalid registered server origin.');
    const url = new URL('/latency', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const samples: number[] = [];
    let started = 0;
    let finished = false;
    const finish = (value?: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      socket.close();
      if (value === undefined) reject(new Error('Latency unavailable.'));
      else resolve(value);
    };
    const aborted = () => finish();
    const timeout = setTimeout(aborted, PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', aborted, { once: true });
    const send = () => {
      started = performance.now();
      socket.send('ping');
    };
    // Start after the handshake so DNS, TLS and connection setup are excluded.
    socket.onopen = send;
    socket.onmessage = (event) => {
      if (finished) return;
      if (event.data !== 'pong') return finish();
      samples.push(performance.now() - started);
      if (samples.length === 3) finish(samples.sort((a, b) => a - b)[1]);
      else send();
    };
    socket.onerror = aborted;
    socket.onclose = aborted;
  });
}

interface Target {
  origin: string;
  visible: boolean;
  update(value: number | undefined): void;
}

/** One bounded probe per visible server, regardless of how many rooms it hosts. */
export function roomLatency(probe = measureLatency) {
  const targets = new Map<Element, Target>();
  const cache = new Map<string, { at: number; value: number | undefined }>();
  const active = new Map<string, AbortController>();
  let disposed = false;
  let pageHidden = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = targets.get(entry.target);
      if (target) target.visible = entry.isIntersecting;
    }
    pump();
  });
  function pump() {
    clearTimeout(timer);
    if (disposed || pageHidden || document.hidden) return;
    const visible = new Set([...targets.values()].filter((t) => t.visible).map((t) => t.origin));
    for (const origin of visible) {
      if (active.size >= 4) break;
      if (
        active.has(origin) ||
        performance.now() - (cache.get(origin)?.at ?? -Infinity) < REFRESH_MS
      )
        continue;
      const controller = new AbortController();
      active.set(origin, controller);
      const startedAt = performance.now();
      void probe(origin, controller.signal)
        .catch(() => undefined)
        .then((value) => {
          if (controller.signal.aborted || disposed) return;
          cache.set(origin, { at: startedAt, value });
          for (const target of targets.values()) if (target.origin === origin) target.update(value);
        })
        .finally(() => {
          active.delete(origin);
          pump();
        });
    }
    const deadlines = [...visible]
      .filter((origin) => !active.has(origin) && cache.has(origin))
      .map((origin) => cache.get(origin)!.at + REFRESH_MS);
    if (deadlines.length && active.size < 4)
      timer = setTimeout(pump, Math.max(1, Math.min(...deadlines) - performance.now()));
  }
  function suspend() {
    clearTimeout(timer);
    for (const controller of active.values()) controller.abort();
    cache.clear();
    for (const target of targets.values()) target.update(undefined);
  }
  const visibility = () => {
    if (document.hidden) suspend();
    else pump();
  };
  document.addEventListener('visibilitychange', visibility);
  const pagehide = () => {
    pageHidden = true;
    suspend();
  };
  const pageshow = () => {
    pageHidden = false;
    pump();
  };
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  return {
    watch(element: Element, origin: string, update: Target['update']) {
      targets.set(element, { origin, visible: false, update });
      update(cache.get(origin)?.value);
      observer.observe(element);
      return () => {
        observer.unobserve(element);
        targets.delete(element);
        if (![...targets.values()].some((t) => t.origin === origin)) {
          active.get(origin)?.abort();
          cache.delete(origin);
        }
      };
    },
    dispose() {
      disposed = true;
      suspend();
      observer.disconnect();
      targets.clear();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    },
  };
}
